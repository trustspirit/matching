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
    (req) => handler(req, n++),
  );
  try {
    await body();
  } finally {
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
