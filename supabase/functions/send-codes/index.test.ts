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
      // The failed participant is still owed a code -- send_attempts (1) is
      // well under the ceiling -- so the run is not "done", it is "partial".
      assertEquals(body.outcome, "partial");
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

Deno.test("a partial run stays armed instead of silently dropping the failure", async () => {
  // This is the hole the failedThisRun approach opened: if a lone failure
  // could make the batch look empty, the run would read that as "done" and
  // disarm -- and since send_attempts (1) is nowhere near the needsAttention
  // threshold (5), nobody would ever be told this participant has no code.
  await seed(3);
  await (await call("arm")).body?.cancel();

  await withBrevo(
    (_req, n) =>
      n === 0
        ? new Response(JSON.stringify({ message: "invalid email" }), { status: 400 })
        : new Response("{}", { status: 201 }),
    async () => {
      const body = await (await call("run")).json();
      assertEquals(body.outcome, "partial");
    },
  );

  assertEquals(
    await sql("select value from app_config where key = 'code_send_armed';"),
    "true",
  );
});

Deno.test("a participant who exhausts every attempt lets the run finish and disarm", async () => {
  await seed(1);
  await (await call("arm")).body?.cancel();

  // recordFailure leaves the claim in place for the rest of THIS run, so one
  // bad address is only attempted once per run -- reaching the five-attempt
  // ceiling takes five separate runs, each picking the row back up after the
  // previous run's finally() releases it. The first four each still find the
  // participant owed a code (outcome "partial"); only the fifth, once
  // send_attempts hits MAX_ATTEMPTS, sees a genuinely empty queue.
  let calls = 0;
  await withBrevo(
    () => {
      calls++;
      return new Response(JSON.stringify({ message: "invalid email" }), { status: 400 });
    },
    async () => {
      for (let i = 1; i <= 5; i++) {
        const body = await (await call("run")).json();
        assertEquals(body.sent, 0, `run ${i}`);
        assertEquals(body.failed, 1, `run ${i}`);
        assertEquals(body.outcome, i < 5 ? "partial" : "done", `run ${i}`);
      }
    },
  );

  assertEquals(calls, 5);
  assertEquals(
    await sql("select send_attempts from participants where display_name = '사람0';"),
    "5",
  );
  // Attempts at the ceiling is exactly what makes the admin's 확인 필요 count
  // pick this participant up.
  assertEquals(
    await sql("select value from app_config where key = 'code_send_armed';"),
    "false",
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

Deno.test("a claim held by a dead run is reclaimed after five minutes", async () => {
  await seed(2);
  await sql(
    "update participants set send_claim_id = gen_random_uuid(), send_claimed_at = now();",
  );
  await (await call("arm")).body?.cancel();

  // Fresh claims are respected: a run in flight must not be trampled.
  await withBrevo(
    () => new Response("{}", { status: 201 }),
    async () => {
      assertEquals((await (await call("run")).json()).sent, 0);
    },
  );

  await sql("update participants set send_claimed_at = now() - interval '6 minutes';");
  await withBrevo(
    () => new Response("{}", { status: 201 }),
    async () => {
      assertEquals((await (await call("run")).json()).sent, 2);
    },
  );
});

Deno.test("re-minting a code cancels the send that already claimed it", async () => {
  await seed(1);
  await (await call("arm")).body?.cancel();

  // The claim moves while the message is in flight -- exactly what a
  // concurrent reissue does. Awaiting inside the handler makes this
  // deterministic: the write lands before the send returns, so the stamp that
  // follows is guaranteed to find a claim that is no longer ours.
  await withBrevo(
    async () => {
      await sql("update participants set send_claim_id = gen_random_uuid();");
      return new Response("{}", { status: 201 });
    },
    async () => {
      await (await call("run")).body?.cancel();
    },
  );

  // The mail went out but the claim moved, so nothing was stamped. The row is
  // still pending and the newer request owns it.
  assertEquals(await sql("select count(*) from participants where code_sent_at is null;"), "1");
});

Deno.test("two concurrent runs never mail the same person twice", async () => {
  await seed(6);
  await (await call("arm")).body?.cancel();

  let calls = 0;
  let sentA = 0;
  let sentB = 0;
  await withBrevo(
    async () => {
      calls++;
      // The delay is what gives this test teeth. While run A is still sending,
      // its rows are claimed but not yet stamped, so run B's claim really does
      // reach them and has to be refused by the claim guard alone. Remove the
      // delay and A stamps everything first, leaving `code_sent_at is null` to
      // do the work -- the test would then pass with the guard deleted.
      await new Promise((resolve) => setTimeout(resolve, 200));
      return new Response("{}", { status: 201 });
    },
    async () => {
      const [a, b] = await Promise.all([call("run"), call("run")]);
      const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);
      sentA = bodyA.sent;
      sentB = bodyB.sent;
    },
  );

  // With BATCH = 100 and only 6 participants seeded, one run legitimately
  // claiming all six is correct behaviour, not a bug -- claim_pending_codes
  // has no obligation to split work evenly between two runs. So this does
  // NOT assert sentA > 0 && sentB > 0; the invariant under test is only that
  // nobody is mailed twice, which the totals below are enough to show.
  assertEquals(calls, 6);
  assertEquals(sentA + sentB, 6);
  assertEquals(await sql("select count(*) from participants where code_sent_at is null;"), "0");
});
