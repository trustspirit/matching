import { assert, assertEquals } from "jsr:@std/assert@1";

const BASE = Deno.env.get("FUNCTIONS_URL") ?? "http://127.0.0.1:54321/functions/v1";
const PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "local-admin";

const HEADER =
  "부,시간,장소,조,남성 이름,남성 생년월일,남성 연락처,남성 이메일,여성 이름,여성 생년월일,여성 연락처,여성 이메일";

let sessionToken = "";

/** admin-import now takes a session token; admin-data's `login` mints it. */
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

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

const ROW_A =
  "1부,,소극장,3조,임포트남,1999-01-02,010-0000-0001,a@example.com,임포트여,1999-05-06,010-0000-0002,b@example.com";

async function upload(
  content: string,
  options: { password?: string; regenerate?: boolean } = {},
): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "text/csv" }), "matches.csv");
  if (options.regenerate) form.append("regenerateCodes", "true");
  return await fetch(`${BASE}/admin-import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.password ?? await token()}` },
    body: form,
  });
}

async function lookup(name: string, code: string): Promise<Response> {
  return await fetch(`${BASE}/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, code }),
  });
}

/** Pulls a participant's plaintext code out of the returned code CSV. */
function codeFor(codesCsv: string, displayName: string): string {
  const line = codesCsv.split("\n").find((l) => l.startsWith(`${displayName},`));
  assert(line, `no code row for ${displayName}`);
  return line.split(",").at(-1)!;
}

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

Deno.test("rejects a request with no credentials", async () => {
  const res = await fetch(`${BASE}/admin-import`, { method: "POST" });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("rejects an unknown token", async () => {
  const res = await upload(csv(ROW_A), { password: "nope" });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

// Tests below this point run in declaration order against a shared DB and
// deliberately build on each other's state (see the file-level note above).
// Once a participant has been imported once, re-uploading the same row
// without regenerateCodes correctly returns "기존 코드 유지" instead of a
// plaintext code (the server cannot recover an old code, only its hash) — so
// later tests that need a *working* code for 임포트남 must carry it forward
// from the last upload that actually minted one, rather than re-deriving it
// from a plain re-upload.
let latestMaleCode = "";

Deno.test("imports participants and matches, returning plaintext codes", async () => {
  const res = await upload(csv(ROW_A));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.matches, 1);
  assertEquals(body.participants.created, 2);
  assert(body.codesCsv.startsWith("이름,성별,연락처,이메일,코드"));

  // The returned code must actually work.
  const code = codeFor(body.codesCsv, "임포트남");
  const login = await lookup("임포트남", code);
  assertEquals(login.status, 200);
  assertEquals((await login.json()).matches[0].partnerName, "임포트여");
  latestMaleCode = code;
});

Deno.test("keeps existing codes when re-uploading to add a team", async () => {
  const originalCode = latestMaleCode;

  const withTeam = ROW_A.replace(",3조,", ",7조,");
  const second = await (await upload(csv(withTeam))).json();
  assertEquals(second.participants.created, 0);
  assertEquals(codeFor(second.codesCsv, "임포트남"), "기존 코드 유지");

  const login = await lookup("임포트남", originalCode);
  assertEquals(login.status, 200);
  assertEquals((await login.json()).matches[0].team, "7조");
});

Deno.test("replaces every code when regenerateCodes is set", async () => {
  const originalCode = latestMaleCode;

  const second = await (await upload(csv(ROW_A), { regenerate: true })).json();
  const newCode = codeFor(second.codesCsv, "임포트남");
  assert(newCode !== "기존 코드 유지");

  assertEquals((await lookup("임포트남", originalCode)).status, 401);
  assertEquals((await lookup("임포트남", newCode)).status, 200);
  latestMaleCode = newCode;
});

Deno.test("derives the schedule when 시간 is blank", async () => {
  const body = await (await upload(csv(ROW_A))).json();
  assertEquals(body.matches, 1);
  const match = (await (await lookup("임포트남", latestMaleCode)).json()).matches[0];
  assertEquals(match.timeRange, "21:50~22:20");
  assertEquals(match.arriveBy, "21:50");
});

Deno.test("reports a blank team as a warning without failing", async () => {
  const noTeam = ROW_A.replace(",3조,", ",,");
  const body = await (await upload(csv(noTeam))).json();
  assertEquals(body.warnings.length, 1);
  assert(body.warnings[0].includes("2행"));
});

Deno.test("writes nothing when the CSV has errors", async () => {
  const seeded = await upload(csv(ROW_A));
  await seeded.body?.cancel();

  const broken = ROW_A.replace("1부", "3부");
  const res = await upload(csv(broken));
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(body.errors.length > 0);

  // The previously imported match must still be intact.
  const check = await upload(csv(ROW_A));
  assertEquals((await check.json()).participants.created, 0);
});

Deno.test("re-import resets the send queue, but only clears code_sent_at and the send claim when the code actually changed", async () => {
  // A stale ceiling/claim/error from a run that happened before this
  // correction. A re-upload -- the admin's most natural fix for a typo'd
  // address -- must reopen the row for claim_pending_codes.
  const staleClaimId = crypto.randomUUID();
  await sql(
    `update participants
        set send_attempts   = 5,
            send_last_error = 'old failure',
            send_claim_id   = '${staleClaimId}',
            send_claimed_at = now(),
            code_sent_at    = now()
      where name = '임포트남';`,
  );

  // No regenerateCodes: the code is kept, so this participant was already
  // notified about the code they still have and must not be queued again.
  const kept = await (await upload(csv(ROW_A))).json();
  assertEquals(codeFor(kept.codesCsv, "임포트남"), "기존 코드 유지");
  assertEquals(
    await sql("select send_attempts from participants where name = '임포트남';"),
    "0",
  );
  assertEquals(
    await sql("select send_last_error is null from participants where name = '임포트남';"),
    "t",
  );
  // The code did not change, so a run still mid-flight sending it must be
  // allowed to finish: the claim it holds must survive the re-import, or its
  // later stamp() (guarded by `eq("send_claim_id", runId)`) becomes a no-op
  // and the participant gets mailed a second, redundant code next run.
  assertEquals(
    await sql(
      `select send_claim_id = '${staleClaimId}' and send_claimed_at is not null from participants where name = '임포트남';`,
    ),
    "t",
  );
  assertEquals(
    await sql("select code_sent_at is not null from participants where name = '임포트남';"),
    "t",
  );

  // Put the same stale state back, then force a real code change.
  await sql(
    `update participants
        set send_attempts = 5,
            send_claim_id = gen_random_uuid()
      where name = '임포트남';`,
  );
  const regenerated = await (await upload(csv(ROW_A), { regenerate: true })).json();
  const newCode = codeFor(regenerated.codesCsv, "임포트남");
  assert(newCode !== "기존 코드 유지");
  latestMaleCode = newCode;

  assertEquals(
    await sql("select send_attempts from participants where name = '임포트남';"),
    "0",
  );
  assertEquals(
    await sql("select send_claim_id is null from participants where name = '임포트남';"),
    "t",
  );
  // The code changed, so the old notification no longer describes reality --
  // code_sent_at must go back to null so the new code actually gets sent.
  assertEquals(
    await sql("select code_sent_at is null from participants where name = '임포트남';"),
    "t",
  );
});

Deno.test("re-import with an unchanged code leaves an in-flight send claim alone", async () => {
  // Simulate a run mid-flight: it has claimed 임포트남 to send them a code.
  const claimId = crypto.randomUUID();
  await sql(
    `update participants
        set send_claim_id   = '${claimId}',
            send_claimed_at = now()
      where name = '임포트남';`,
  );

  // No regenerateCodes: the code is unchanged, so the claim above still
  // guards a send that is genuinely in progress for the code the participant
  // still has -- it must not be invalidated out from under that run.
  const reimported = await (await upload(csv(ROW_A))).json();
  assertEquals(codeFor(reimported.codesCsv, "임포트남"), "기존 코드 유지");

  assertEquals(
    await sql("select send_claim_id from participants where name = '임포트남';"),
    claimId,
  );
});

Deno.test("merges an aliased name into a single participant", async () => {
  const aliasRow =
    "2부,,골드,1조,이승호- lee Seung ho,2003-03-25,010-2213-1840,tr@example.com,별칭여,2002-02-02,,";
  // Same 조 on both rows: it belongs to the person, so the alias and the plain
  // spelling -- one participant -- cannot disagree about it.
  const plainRow =
    "1부,,실버,1조,이승호,2003-03-25,010-2213-1840,tr@example.com,다른여,2001-01-01,,";
  const body = await (await upload(csv(aliasRow, plainRow))).json();

  // Two rows, but only three distinct people: one man and two women.
  assertEquals(body.participants.created, 3);

  const code = codeFor(body.codesCsv, "이승호");
  const login = await (await lookup("이승호", code)).json();
  assertEquals(login.matches.length, 2);
});

Deno.test("rejects a request with no file", async () => {
  const res = await fetch(`${BASE}/admin-import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}` },
    body: new FormData(),
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});


const HEADER_SPLIT_TEAM =
  "부,시간,장소,조,남성 이름,남성 생년월일,남성 연락처,남성 이메일,조,여성 이름,여성 생년월일,여성 연락처,여성 이메일";

const ROW_SPLIT_TEAM =
  "1부,,소극장,3조,조남,1999-01-02,010-0000-0011,c@example.com,5조,조여,1999-05-06,010-0000-0012,d@example.com";

Deno.test("gives each person their own 조 when the CSV has two 조 columns", async () => {
  const body = await (await upload(
    [HEADER_SPLIT_TEAM, ROW_SPLIT_TEAM].join("\n"),
  )).json();
  assertEquals(body.matches, 1);

  // Each participant is told their OWN 조, not their partner's -- the two
  // differ here, which is exactly the case a single shared column used to lose.
  const male = await (await lookup("조남", codeFor(body.codesCsv, "조남"))).json();
  assertEquals(male.matches[0].team, "3조");
  const female = await (await lookup("조여", codeFor(body.codesCsv, "조여"))).json();
  assertEquals(female.matches[0].team, "5조");

  // And it is stored on the participant, not on the pairing.
  assertEquals(
    await sql("select team from participants where display_name = '조남';"),
    "3조",
  );
});

Deno.test("refuses a CSV that gives one person two different 조", async () => {
  const second = ROW_SPLIT_TEAM
    .replace(",3조,", ",9조,")
    .replace("조여", "다른여")
    .replace("1999-05-06", "1998-04-05");
  const res = await upload(
    [HEADER_SPLIT_TEAM, ROW_SPLIT_TEAM, second].join("\n"),
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(body.errors.some((e: string) => e.includes("조남")), body.errors.join(" "));
});

Deno.test("rejects a spreadsheet formula error instead of storing it as a 조", async () => {
  const broken = ROW_SPLIT_TEAM.replace(",3조,", ",#NAME?,");
  const res = await upload([HEADER_SPLIT_TEAM, broken].join("\n"));
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(body.errors.some((e: string) => e.includes("#NAME?")), body.errors.join(" "));

  // Nothing was written: the previous import is still the live match set.
  assertEquals(await sql("select count(*) from matches;"), "1");
});
