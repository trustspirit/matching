import { assert, assertEquals } from "jsr:@std/assert@1";

const BASE = Deno.env.get("FUNCTIONS_URL") ?? "http://127.0.0.1:54321/functions/v1";
const PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "local-admin";

const HEADER =
  "부,시간,장소,조,남성 이름,남성 생년월일,남성 연락처,남성 이메일,여성 이름,여성 생년월일,여성 연락처,여성 이메일";

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
    headers: { Authorization: `Bearer ${options.password ?? PASSWORD}` },
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

Deno.test("rejects a request with no credentials", async () => {
  const res = await fetch(`${BASE}/admin-import`, { method: "POST" });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("rejects a wrong password", async () => {
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

Deno.test("merges an aliased name into a single participant", async () => {
  const aliasRow =
    "2부,,골드,1조,이승호- lee Seung ho,2003-03-25,010-2213-1840,tr@example.com,별칭여,2002-02-02,,";
  const plainRow =
    "1부,,실버,2조,이승호,2003-03-25,010-2213-1840,tr@example.com,다른여,2001-01-01,,";
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
    headers: { Authorization: `Bearer ${PASSWORD}` },
    body: new FormData(),
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});
