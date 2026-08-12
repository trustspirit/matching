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
  assert(Array.isArray(body.needsAttentionSample));
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

/**
 * A distinct, well-formed code per seeded row. Codes are stored as themselves
 * and carry a unique index, so a seed cannot hand two rows the same string --
 * and a run mails whatever is here, so it has to look like a real code.
 * Digits are drawn from the alphabet's 2-9, giving 64 distinct codes.
 */
function testCode(i: number): string {
  const digits = "23456789";
  // TEST, not CODE: O is one of the ambiguous letters the alphabet leaves out,
  // so a code containing it would not survive the validator or the assertions
  // that scrape a code out of a sent message.
  return `TEST${digits[Math.floor(i / 8) % 8]}${digits[i % 8]}`;
}

Deno.test("status names who needs attention, not just how many", async () => {
  await sql("delete from participants;");
  await sql(
    `insert into participants (name, display_name, birthdate, gender, email, code, send_attempts, send_last_error)
     values ('확인남', '확인남', '1990-01-01', 'M', 'a@example.com', '${testCode(0)}', 5, '402 quota exceeded');`,
  );
  await sql(
    `insert into participants (name, display_name, birthdate, gender, email, code, send_attempts)
     values ('대기녀', '대기녀', '1990-01-01', 'F', 'b@example.com', '${testCode(1)}', 0);`,
  );

  const body = await (await call("status")).json();
  assertEquals(body.needsAttention, 1);
  assertEquals(body.needsAttentionSample.length, 1);
  assertEquals(body.needsAttentionSample[0].displayName, "확인남");
  assertEquals(body.needsAttentionSample[0].error, "402 quota exceeded");
});

Deno.test("the needs-attention sample is capped, not the count behind it", async () => {
  await sql("delete from participants;");
  const ATTENTION_SAMPLE_LIMIT = 10;
  const total = ATTENTION_SAMPLE_LIMIT + 3;
  for (let i = 0; i < total; i++) {
    await sql(
      `insert into participants (name, display_name, birthdate, gender, email, code, send_attempts)
       values ('막힘${i}', '막힘${i}', '1990-01-01', 'M', 'm${i}@example.com', '${testCode(i)}', 5);`,
    );
  }

  const body = await (await call("status")).json();
  assertEquals(body.needsAttention, total);
  assertEquals(body.needsAttentionSample.length, ATTENTION_SAMPLE_LIMIT);
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

async function seed(count: number): Promise<void> {
  await sql("delete from participants;");
  for (let i = 0; i < count; i++) {
    await sql(
      `insert into participants (name, display_name, birthdate, gender, email, code)
       values ('사람${i}', '사람${i}', '1990-01-01', 'M', 'p${i}@example.com', '${testCode(i)}');`,
    );
  }
}

/** Remaining credits the stubbed account reports; tests override per case. */
let stubCredits = 1000;

/**
 * The From address Brevo will admit to knowing. Defaults to the one the
 * function container is configured with (package.json passes it through from
 * supabase/functions/.env) so the validation guard passes; a test that wants
 * the guard to fire points it somewhere else.
 */
const SENDER = Deno.env.get("BREVO_SENDER_EMAIL") ?? "noreply@example.com";
let stubSender = SENDER;

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
      // Neither probe is a send: both are answered here so they cannot
      // advance the call counter, or every test's "the third message fails"
      // bookkeeping shifts by one.
      const path = new URL(req.url).pathname;
      if (path.endsWith("/v3/account")) {
        return new Response(
          JSON.stringify({
            plan: [{ credits: stubCredits, creditsType: "sendLimit" }],
            dateTimePreferences: { timezone: "Asia/Seoul" },
          }),
          { status: 200 },
        );
      }
      if (path.endsWith("/v3/senders")) {
        return new Response(
          JSON.stringify({ senders: [{ id: 1, email: stubSender, active: true }] }),
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
    stubSender = SENDER;
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
  // A run mails the code each row already holds, so nobody's changed.
  assertEquals(await sql("select count(distinct code) from participants;"), "3");
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

Deno.test("a participant who exhausts every attempt is reported blocked, not silently done (F1)", async () => {
  // This test used to assert the 5th run's outcome was "done" -- that was the
  // F1 bug: pendingCount() hits 0 once every reachable row is past
  // MAX_ATTEMPTS, and treating that the same as a genuinely empty queue tells
  // the admin "전원 발송을 마쳤습니다" while this participant has no code and
  // never will until someone intervenes. The correct outcome is the new
  // "blocked" branch, with the RunSummary.blocked count naming how many.
  await seed(1);
  await (await call("arm")).body?.cancel();

  // recordFailure leaves the claim in place for the rest of THIS run, so one
  // bad address is only attempted once per run -- reaching the five-attempt
  // ceiling takes five separate runs, each picking the row back up after the
  // previous run's finally() releases it. The first four each still find the
  // participant owed a code (outcome "partial"); only the fifth, once
  // send_attempts hits MAX_ATTEMPTS, sees a genuinely empty claim batch --
  // which must now be reported as "blocked", not "done".
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
        assertEquals(body.outcome, i < 5 ? "partial" : "blocked", `run ${i}`);
        assertEquals(body.blocked, i < 5 ? 0 : 1, `run ${i}`);
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

Deno.test("F1: an empty queue with nothing blocked still reports done, not blocked", async () => {
  // Guards the other half of the branch: pendingCount 0 AND blockedCount 0
  // must stay "done" with blocked: 0, exactly as before F1.
  await seed(2);
  await (await call("arm")).body?.cancel();

  await withBrevo(
    () => new Response("{}", { status: 201 }),
    async () => {
      const body = await (await call("run")).json();
      assertEquals(body.outcome, "done");
      assertEquals(body.blocked, 0);
    },
  );
});

Deno.test("F1: an outage that runs everyone to the ceiling is reported blocked, disarmed, with an accurate count", async () => {
  // The scenario from the finding: several participants all fail every
  // attempt (standing in for a transient Brevo/network outage), so every
  // reachable row is eventually stuck at MAX_ATTEMPTS with no code sent.
  // pendingCount() alone cannot tell this apart from a clean finish; only
  // blockedCount() can, and the outcome must say so.
  await seed(3);
  await (await call("arm")).body?.cancel();

  await withBrevo(
    () => new Response(JSON.stringify({ message: "invalid email" }), { status: 400 }),
    async () => {
      let last;
      for (let i = 1; i <= 5; i++) {
        last = await (await call("run")).json();
      }
      assertEquals(last.outcome, "blocked");
      assertEquals(last.blocked, 3);
      assertEquals(last.sent, 0);
    },
  );

  // Ceiling-blocked rows cannot be progressed by cron; staying armed would
  // just re-run the same empty, ceiling-blocked batch every five minutes.
  assertEquals(
    await sql("select value from app_config where key = 'code_send_armed';"),
    "false",
  );
  assertEquals(
    await sql("select count(*) from participants where code_sent_at is null;"),
    "3",
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

Deno.test("a claim that moves mid-flight stops the run from stamping the row", async () => {
  await seed(1);
  await (await call("arm")).body?.cancel();

  // The claim moves while the message is in flight -- what a concurrent
  // reissue or admin send does. Awaiting inside the handler makes this
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

Deno.test("a run mails the stored code and leaves it in place", async () => {
  await seed(1);
  await (await call("arm")).body?.cancel();
  const before = await sql("select code from participants where display_name = '사람0';");

  let mailed = "";
  await withBrevo(async (req) => {
    mailed = String((await req.json()).htmlContent)
      .match(/font-size:24px[^>]*>([23456789ABCDEFGHJKMNPQRSTVWXYZ]{6})</)?.[1] ?? "";
    return new Response("{}", { status: 201 });
  }, async () => {
    assertEquals((await (await call("run")).json()).sent, 1);
  });

  assertEquals(mailed, before);
  assertEquals(
    await sql("select code from participants where display_name = '사람0';"),
    before,
  );
});

Deno.test("a rejected send leaves the code the participant already has", async () => {
  await seed(1);
  await (await call("arm")).body?.cancel();
  const before = await sql("select code from participants where display_name = '사람0';");

  await withBrevo(
    () => new Response("nope", { status: 500 }),
    async () => {
      const body = await (await call("run")).json();
      assertEquals(body.sent, 0);
      assertEquals(body.failed, 1);
      // Not "done": the row is still owed its mail, it just could not be
      // delivered this attempt.
      assertEquals(body.outcome, "partial");
    },
  );

  // A run used to mint and write a new code before every attempt, so a
  // failure like this replaced a working code with one that existed only in
  // an email that never arrived.
  assertEquals(
    await sql("select code from participants where display_name = '사람0';"),
    before,
  );
  assertEquals(
    await sql("select send_attempts from participants where display_name = '사람0';"),
    "1",
  );
  // The claim must not be left behind, or the row is invisible to the next
  // run for the full five-minute stale window on top of the failure itself.
  assertEquals(
    await sql("select send_claim_id is null from participants where display_name = '사람0';"),
    "t",
  );
});

Deno.test("a run refuses to start when the From address is not validated", async () => {
  await seed(3);
  await (await call("arm")).body?.cancel();

  let attempted = 0;
  stubSender = "someone-else@example.com";
  await withBrevo(() => {
    attempted++;
    return new Response("{}", { status: 201 });
  }, async () => {
    const body = await (await call("run")).json();
    assertEquals(body.outcome, "sender");
    assertEquals(body.sent, 0);
  });

  // Brevo would have taken all three with a 201 and discarded them at the
  // relay, leaving three participants stamped as notified with nothing in
  // their inbox -- and nothing anywhere in the run to say so.
  assertEquals(attempted, 0);
  assertEquals(await sql("select count(*) from participants where code_sent_at is not null;"), "0");
  // Still armed: the queue is untouched, so the next run after the address is
  // fixed picks up exactly where this one refused.
  assertEquals((await (await call("status")).json()).armed, true);
  await (await call("disarm")).body?.cancel();
});
