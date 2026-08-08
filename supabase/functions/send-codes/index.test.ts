import { assert, assertEquals } from "jsr:@std/assert@1";

const BASE = Deno.env.get("FUNCTIONS_URL") ?? "http://127.0.0.1:54321/functions/v1";
const PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "local-admin";

let sessionToken = "";

async function token(): Promise<string> {
  if (sessionToken !== "") return sessionToken;
  const res = await fetch(`${BASE}/admin-data`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PASSWORD}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "login" }),
  });
  assertEquals(res.status, 200);
  sessionToken = (await res.json()).token;
  return sessionToken;
}

async function call(
  action: string,
  options: { auth?: string; cronSecret?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.cronSecret !== undefined) {
    headers["x-cron-secret"] = options.cronSecret;
  } else {
    headers.Authorization = `Bearer ${options.auth ?? await token()}`;
  }
  return await fetch(`${BASE}/send-codes`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action }),
  });
}

Deno.test("an unauthenticated call is refused", async () => {
  const res = await call("status", { auth: "not-a-token" });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("status reports the arm flag and the pending count", async () => {
  const res = await call("status");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.armed, false);
  assert(typeof body.pending === "number");
  assert(typeof body.needsAttention === "number");
});

Deno.test("arm and disarm round-trip", async () => {
  const armed = await call("arm");
  assertEquals((await armed.json()).armed, true);

  const after = await call("status");
  assertEquals((await after.json()).armed, true);

  const disarmed = await call("disarm");
  assertEquals((await disarmed.json()).armed, false);
});

Deno.test("a run does nothing while disarmed", async () => {
  await (await call("disarm")).body?.cancel();
  const res = await call("run");
  assertEquals(res.status, 200);
  assertEquals((await res.json()).outcome, "disarmed");
});

/**
 * Runs SQL through the psql inside the database container. The host has no
 * psql installed, and the tests need no database client of their own.
 */
async function sql(statement: string): Promise<string> {
  const command = new Deno.Command("docker", {
    args: [
      "exec",
      "supabase_db_blind-date-match",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tAc",
      statement,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout).trim();
}

async function seed(count: number): Promise<void> {
  await sql("delete from participants;");
  for (let i = 0; i < count; i++) {
    await sql(
      `insert into participants (name, display_name, birthdate, gender, email, code_salt, code_hash)
       values ('사람${i}', '사람${i}', '1990-01-01', 'M', 'p${i}@example.com', 's${i}', 'h${i}');`,
    );
  }
}

/** Remaining credits the stubbed account reports; tests override per case. */
let stubCredits = 1000;

/**
 * Stands in for Brevo. The function container reads BREVO_API_URL per request,
 * so the port stays fixed and only the behaviour changes per test. `n` is the
 * zero-based call index, which is how a test makes the third message fail.
 */
async function withBrevo(
  handler: (req: Request, n: number) => Response | Promise<Response>,
  body: () => Promise<void>,
): Promise<void> {
  let n = 0;
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 8799, signal: controller.signal, onListen: () => {} },
    (req) => {
      // The account probe is not a send: it must not advance the call counter,
      // or every test's "the third message fails" bookkeeping shifts by one.
      if (new URL(req.url).pathname.endsWith("/v3/account")) {
        return new Response(
          JSON.stringify({
            plan: [{ credits: stubCredits, creditsType: "sendLimit" }],
            dateTimePreferences: { timezone: "Asia/Seoul" },
          }),
          { status: 200 },
        );
      }
      return handler(req, n++);
    },
  );
  try {
    stubCredits = 1000;
    await body();
  } finally {
    stubCredits = 1000;
    controller.abort();
    await server.finished;
  }
}

Deno.test("a run mails every pending participant and stamps them", async () => {
  await seed(3);
  await (await call("arm")).body?.cancel();

  await withBrevo(
    () => new Response("{}", { status: 201 }),
    async () => {
      const body = await (await call("run")).json();
      assertEquals(body.outcome, "done");
      assertEquals(body.sent, 3);
      assertEquals(body.failed, 0);
    },
  );

  assertEquals(await sql("select count(*) from participants where code_sent_at is null;"), "0");
  assertEquals(await sql("select count(*) from participants where send_claim_id is not null;"), "0");
  // Codes are per-row salted, so uniqueness cannot be a constraint. Prove it.
  assertEquals(await sql("select count(distinct code_hash) from participants;"), "3");
});

Deno.test("finishing the queue disarms so the next import is safe", async () => {
  const res = await call("status");
  assertEquals((await res.json()).armed, false);
});

Deno.test("an empty allowance sends nothing and books the next reset", async () => {
  await seed(3);
  await (await call("arm")).body?.cancel();

  let sends = 0;
  await withBrevo(
    () => {
      sends++;
      return new Response("{}", { status: 201 });
    },
    async () => {
      stubCredits = 0;
      const body = await (await call("run")).json();
      assertEquals(body.outcome, "quota");
      assertEquals(body.sent, 0);
    },
  );

  // Nothing may be attempted, and no code may be minted and thrown away.
  assertEquals(sends, 0);
  assertEquals(await sql("select count(*) from participants where send_claim_id is not null;"), "0");

  // The appointment is the account's next midnight, so it must be in the
  // future but well under a day away.
  assertEquals(
    await sql(
      "select (value::timestamptz > now() and value::timestamptz < now() + interval '25 hours') from app_config where key = 'send_retry_after';",
    ),
    "t",
  );
  // Still armed: the job is waiting, not finished.
  assertEquals(
    await sql("select value from app_config where key = 'code_send_armed';"),
    "true",
  );
});

Deno.test("a 402 stops the run and leaves the rest queued", async () => {
  await seed(3);
  await (await call("arm")).body?.cancel();

  await withBrevo(
    (_req, n) =>
      n === 0
        ? new Response("{}", { status: 201 })
        : new Response(JSON.stringify({ code: "not_enough_credits" }), { status: 402 }),
    async () => {
      const body = await (await call("run")).json();
      assertEquals(body.outcome, "quota");
      assertEquals(body.sent, 1);
    },
  );

  assertEquals(await sql("select count(*) from participants where code_sent_at is null;"), "2");
  // Nothing may stay claimed, or the next run waits five minutes for nothing.
  assertEquals(await sql("select count(*) from participants where send_claim_id is not null;"), "0");
  // A quota wall is not the participant's fault; it must not count against them.
  assertEquals(await sql("select coalesce(max(send_attempts), 0) from participants;"), "0");

  // The job is not finished, so it must stay armed for tomorrow...
  assertEquals(
    await sql("select value from app_config where key = 'code_send_armed';"),
    "true",
  );
  // ...but the cron gate must be closed for the next half hour, or the
  // schedule re-probes every five minutes for the rest of the day.
  assertEquals(
    await sql(
      "select (value::timestamptz > now() + interval '25 minutes') from app_config where key = 'send_retry_after';",
    ),
    "t",
  );
});

Deno.test("draining the queue clears the quota backoff", async () => {
  await seed(1);
  await sql(
    "insert into app_config (key, value) values ('send_retry_after', (now() + interval '30 minutes')::text) on conflict (key) do update set value = excluded.value;",
  );
  await (await call("arm")).body?.cancel();

  await withBrevo(
    () => new Response("{}", { status: 201 }),
    async () => {
      assertEquals((await (await call("run")).json()).outcome, "done");
    },
  );

  // A stale timestamp would delay the next event's very first run.
  assertEquals(
    await sql(
      "select coalesce(value, '') from app_config where key = 'send_retry_after';",
    ),
    "",
  );
  assertEquals(
    await sql("select value from app_config where key = 'code_send_armed';"),
    "false",
  );
});

Deno.test("a rejected address fails only that participant", async () => {
  await seed(3);
  await (await call("arm")).body?.cancel();

  await withBrevo(
    (_req, n) =>
      n === 0
        ? new Response(JSON.stringify({ message: "invalid email" }), { status: 400 })
        : new Response("{}", { status: 201 }),
    async () => {
      const body = await (await call("run")).json();
      assertEquals(body.outcome, "done");
      assertEquals(body.sent, 2);
      assertEquals(body.failed, 1);
    },
  );

  assertEquals(await sql("select count(*) from participants where send_attempts = 1;"), "1");
  assertEquals(
    await sql("select count(*) from participants where send_last_error is not null;"),
    "1",
  );
});

Deno.test("a 429 is retried once after the delay Brevo asks for", async () => {
  await seed(1);
  await (await call("arm")).body?.cancel();

  await withBrevo(
    (_req, n) =>
      n === 0
        ? new Response("{}", { status: 429, headers: { "x-sib-ratelimit-reset": "1" } })
        : new Response("{}", { status: 201 }),
    async () => {
      const body = await (await call("run")).json();
      assertEquals(body.sent, 1);
      assertEquals(body.failed, 0);
    },
  );
});

Deno.test("a participant past the attempt ceiling leaves the queue", async () => {
  await seed(2);
  await sql("update participants set send_attempts = 5 where display_name = '사람0';");
  await (await call("arm")).body?.cancel();

  await withBrevo(
    () => new Response("{}", { status: 201 }),
    async () => {
      const body = await (await call("run")).json();
      assertEquals(body.sent, 1);
    },
  );

  assertEquals(
    await sql("select code_sent_at is null from participants where display_name = '사람0';"),
    "t",
  );
});
