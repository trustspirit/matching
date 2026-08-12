import { assert, assertEquals } from "jsr:@std/assert@1";

const BASE = Deno.env.get("FUNCTIONS_URL") ?? "http://127.0.0.1:54321/functions/v1";
const PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "local-admin";

const HEADER =
  "부,시간,장소,조,남성 이름,남성 생년월일,남성 연락처,남성 이메일,여성 이름,여성 생년월일,여성 연락처,여성 이메일";
const ROW_A =
  "1부,,소극장,3조,표남,1999-01-02,010-0000-0001,a@example.com,표여,1999-05-06,010-0000-0002,b@example.com";

/** Logs in once and caches the token for the rest of the file. */
let sessionToken = "";

async function login(password = PASSWORD): Promise<Response> {
  return await fetch(`${BASE}/admin-data`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${password}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "login" }),
  });
}

async function token(): Promise<string> {
  if (sessionToken !== "") return sessionToken;
  const res = await login();
  assertEquals(res.status, 200);
  sessionToken = (await res.json()).token;
  return sessionToken;
}

/** Seeds one match so the listing tests have something to read. */
async function seed(): Promise<void> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([[HEADER, ROW_A].join("\n")], { type: "text/csv" }),
    "matches.csv",
  );
  const res = await fetch(`${BASE}/admin-import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}` },
    body: form,
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
}

async function call(
  action: string,
  params: Record<string, unknown> = {},
  credential?: string,
): Promise<Response> {
  return await fetch(`${BASE}/admin-data`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential ?? await token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, ...params }),
  });
}

Deno.test("rejects a request with no credentials", async () => {
  const res = await fetch(`${BASE}/admin-data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "list_matches" }),
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("login rejects a wrong password", async () => {
  const res = await login("definitely-wrong");
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "unauthorized");
});

Deno.test("the password does not work on a normal action", async () => {
  // Only `login` accepts the password; everything else needs a token.
  const res = await call("list_matches", {}, PASSWORD);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("an unknown token is rejected", async () => {
  const res = await call("list_matches", {}, "0".repeat(64));
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("logout invalidates the token it was called with", async () => {
  const fresh = await (await login()).json();
  assert(typeof fresh.token === "string" && fresh.token.length === 64);
  assertEquals((await call("list_matches", {}, fresh.token)).status, 200);

  const out = await call("logout", {}, fresh.token);
  assertEquals(out.status, 200);
  await out.body?.cancel();

  assertEquals((await call("list_matches", {}, fresh.token)).status, 401);
});

Deno.test("logging out one session leaves another alone", async () => {
  const a = await (await login()).json();
  const b = await (await login()).json();

  await (await call("logout", {}, a.token)).body?.cancel();

  assertEquals((await call("list_matches", {}, a.token)).status, 401);
  assertEquals((await call("list_matches", {}, b.token)).status, 200);
});

Deno.test("rejects an unknown action", async () => {
  const res = await call("drop_everything");
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_request");
});

Deno.test("lists matches with both participants joined", async () => {
  await seed();
  const res = await call("list_matches");
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(body.matches.length >= 1);
  const row = body.matches.find((m: { maleName: string }) => m.maleName === "표남");
  assert(row, "seeded match not found");
  assertEquals(row.femaleName, "표여");
  assertEquals(row.session, "1부");
  assertEquals(row.venue, "소극장");
  // The seeding CSV has one shared 조 column, so both people get the same one.
  // The listing reads it off each participant, not off the match.
  assertEquals(row.maleTeam, "3조");
  assertEquals(row.femaleTeam, "3조");
  assert(typeof row.id === "string" && row.id.length > 0);
  assert(typeof row.maleId === "string" && row.maleId.length > 0);
  assert(typeof row.femaleId === "string" && row.femaleId.length > 0);
});

Deno.test("lists participants", async () => {
  const res = await call("list_participants");
  assertEquals(res.status, 200);
  const body = await res.json();
  const male = body.participants.find(
    (p: { displayName: string }) => p.displayName === "표남",
  );
  assert(male, "seeded participant not found");
  assertEquals(male.gender, "M");
  assertEquals(male.birthdate, "1999-01-02");
});

/**
 * Removes a participant if a previous run left one behind, so the creation
 * tests below can be re-run against the same database without a reset.
 */
async function ensureAbsent(displayName: string): Promise<void> {
  const body = await (await call("list_participants")).json();
  const row = body.participants.find(
    (p: { displayName: string }) => p.displayName === displayName,
  );
  if (row === undefined) return;
  await (await call("delete_participant", { id: row.id })).body?.cancel();
}

/** Looks up the seeded participants' ids for match mutations. */
async function ids(): Promise<{ maleId: string; femaleId: string }> {
  const body = await (await call("list_participants")).json();
  const male = body.participants.find(
    (p: { displayName: string }) => p.displayName === "표남",
  );
  const female = body.participants.find(
    (p: { displayName: string }) => p.displayName === "표여",
  );
  assert(male && female, "seeded participants missing");
  return { maleId: male.id, femaleId: female.id };
}

Deno.test("creates a match and it appears in the listing", async () => {
  await seed();
  const { maleId, femaleId } = await ids();
  const res = await call("create_match", {
    session: "2부",
    timeRange: "22:40~23:00",
    arriveBy: "22:40",
    venue: "골드",
    maleId,
    femaleId,
  });
  assertEquals(res.status, 200);
  const created = await res.json();
  assert(typeof created.id === "string");

  const list = await (await call("list_matches")).json();
  const found = list.matches.find((m: { id: string }) => m.id === created.id);
  assert(found, "created match not in listing");
  assertEquals(found.venue, "골드");
});

Deno.test("rejects a match with a blank time range", async () => {
  const { maleId, femaleId } = await ids();
  const res = await call("create_match", {
    session: "1부",
    timeRange: "",
    arriveBy: "21:50",
    venue: "소극장",
    maleId,
    femaleId,
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_request");
});

Deno.test("updates a match and the change is visible in the listing", async () => {
  const list = await (await call("list_matches")).json();
  const row = list.matches.find((m: { maleName: string }) => m.maleName === "표남");
  assert(row);

  const res = await call("update_match", {
    id: row.id,
    session: row.session,
    timeRange: row.timeRange,
    arriveBy: row.arriveBy,
    venue: row.venue,
    maleId: row.maleId,
    femaleId: row.femaleId,
  });
  assertEquals(res.status, 200);

  const after = await (await call("list_matches")).json();
  const updated = after.matches.find((m: { id: string }) => m.id === row.id);
  assertEquals(updated.venue, row.venue);
});

Deno.test("edits a participant's 조 and every view follows", async () => {
  const list = await (await call("list_participants")).json();
  const row = list.participants.find(
    (p: { displayName: string }) => p.displayName === "표남",
  );
  assert(row);

  const res = await call("update_participant", { ...row, team: "7조" });
  assertEquals(res.status, 200);
  await res.body?.cancel();

  // 조 belongs to the person, so the match listing reads it back off them.
  const after = await (await call("list_matches")).json();
  const match = after.matches.find((m: { maleName: string }) => m.maleName === "표남");
  assertEquals(match.maleTeam, "7조");

  // An empty 조 means "not assigned yet", stored as NULL so the participant
  // screen can show "조 배정 예정".
  const cleared = await call("update_participant", { ...row, team: "" });
  assertEquals(cleared.status, 200);
  await cleared.body?.cancel();
  const reread = await (await call("list_participants")).json();
  const person = reread.participants.find((p: { id: string }) => p.id === row.id);
  assertEquals(person.team, null);
});

Deno.test("deletes a match without touching the participants", async () => {
  const before = await (await call("list_matches")).json();
  const target = before.matches[0];
  assert(target);

  const res = await call("delete_match", { id: target.id });
  assertEquals(res.status, 200);
  await res.body?.cancel();

  const after = await (await call("list_matches")).json();
  assertEquals(
    after.matches.filter((m: { id: string }) => m.id === target.id).length,
    0,
  );

  // The participants must still exist; only the match row was removed.
  const people = await (await call("list_participants")).json();
  assert(
    people.participants.some((p: { id: string }) => p.id === target.maleId),
  );
});

Deno.test("rejects a delete for an unknown id", async () => {
  const res = await call("delete_match", {
    id: "00000000-0000-0000-0000-000000000000",
  });
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "not_found");
});

Deno.test("reports what a participant deletion would remove", async () => {
  await seed();
  const { maleId } = await ids();

  const res = await call("participant_impact", { id: maleId });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.matches.length, 1);
  assertEquals(body.matches[0].partnerName, "표여");
  assertEquals(body.matches[0].session, "1부");
  assertEquals(body.matches[0].venue, "소극장");
});

Deno.test("reports an empty impact for a participant with no match", async () => {
  await ensureAbsent("영향없음");
  const res = await call("create_participant", {
    displayName: "영향없음",
    birthdate: "1995-05-05",
    gender: "M",
    contact: "",
    email: "",
  });
  const created = await res.json();
  // Asserted before use so a failure names the cause instead of surfacing as
  // `undefined` two lines later.
  assertEquals(res.status, 200, `create failed: ${JSON.stringify(created)}`);

  const body = await (await call("participant_impact", { id: created.id })).json();
  assertEquals(body.matches, []);
});

Deno.test("rejects participant_impact without an id", async () => {
  const res = await call("participant_impact");
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_request");
});

/**
 * Finds a participant id by display name. The rename tests below change the
 * display name, so ids() -- which insists both seeded people still exist under
 * their original names -- stops working after them.
 */
async function idOf(displayName: string): Promise<string> {
  const body = await (await call("list_participants")).json();
  const row = body.participants.find(
    (p: { displayName: string }) => p.displayName === displayName,
  );
  assert(row, `participant not found: ${displayName}`);
  return row.id;
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

/** Logs in as a participant to prove a code works. */
async function participantLogin(name: string, code: string): Promise<Response> {
  return await fetch(`${BASE}/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, code }),
  });
}

Deno.test("creates a participant and the returned code works", async () => {
  await ensureAbsent("신규남");
  const res = await call("create_participant", {
    displayName: "신규남",
    birthdate: "1998-08-08",
    gender: "M",
    contact: "010-1111-2222",
    email: "new@example.com",
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(typeof body.id === "string" && body.id.length > 0);
  assert(typeof body.code === "string" && body.code.length === 6);

  // A brand-new participant has no match yet, but the code must authenticate.
  const ok = await participantLogin("신규남", body.code);
  assertEquals(ok.status, 200);
  assertEquals((await ok.json()).matches, []);
});

Deno.test("rejects a duplicate name and birthdate", async () => {
  const res = await call("create_participant", {
    displayName: "신규남",
    birthdate: "1998-08-08",
    gender: "M",
    contact: "",
    email: "",
  });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "duplicate_participant");
});

Deno.test("rejects a participant with a blank name", async () => {
  const res = await call("create_participant", {
    displayName: "   ",
    birthdate: "1998-08-08",
    gender: "M",
    contact: "",
    email: "",
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_request");
});

Deno.test("renaming updates both the lookup key and the display name", async () => {
  await seed();
  const { maleId } = await ids();

  // Capture a working code first: renaming must not invalidate it.
  const reissued = await (await call("regenerate_code", { id: maleId })).json();
  assertEquals((await participantLogin("표남", reissued.code)).status, 200);

  const res = await call("update_participant", {
    id: maleId,
    displayName: "표남고침",
    birthdate: "1999-01-02",
    gender: "M",
    contact: "010-0000-0001",
    email: "a@example.com",
  });
  assertEquals(res.status, 200);

  // The code still authenticates: renaming must not invalidate it.
  assertEquals((await participantLogin("표남고침", reissued.code)).status, 200);

  const list = await (await call("list_participants")).json();
  const row = list.participants.find((p: { id: string }) => p.id === maleId);
  assertEquals(row.displayName, "표남고침");

  // The normalized `name` column is not readable through any API, but
  // import_matches upserts on (name, birthdate). Re-importing under the NEW
  // name must update the same row rather than create a second participant --
  // that only holds if `name` was rewritten alongside `display_name`.
  const renamedRow = ROW_A.replace("표남,1999-01-02", "표남고침,1999-01-02");
  const form = new FormData();
  form.append(
    "file",
    new Blob([[HEADER, renamedRow].join("\n")], { type: "text/csv" }),
    "matches.csv",
  );
  const reimport = await (await fetch(`${BASE}/admin-import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}` },
    body: form,
  })).json();
  assertEquals(reimport.participants.created, 0);
});

Deno.test("updating a participant leaves the code valid", async () => {
  const maleId = await idOf("표남고침");
  const reissued = await (await call("regenerate_code", { id: maleId })).json();

  const res = await call("update_participant", {
    id: maleId,
    displayName: "표남고침",
    birthdate: "1999-01-02",
    gender: "M",
    contact: "010-9999-9999",
    email: "changed@example.com",
  });
  await res.body?.cancel();

  // update_participant must not touch code_salt/code_hash.
  assertEquals((await participantLogin("표남고침", reissued.code)).status, 200);
});

Deno.test("rejects a rename that collides with another participant", async () => {
  const list = await (await call("list_participants")).json();
  const target = list.participants.find(
    (p: { displayName: string }) => p.displayName === "표여",
  );
  assert(target);

  const res = await call("update_participant", {
    id: target.id,
    displayName: "표남고침",
    birthdate: "1999-01-02",
    gender: "F",
    contact: "",
    email: "",
  });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "duplicate_participant");
});

Deno.test("regenerating a code invalidates the old one", async () => {
  const femaleId = await idOf("표여");

  const first = await (await call("regenerate_code", { id: femaleId })).json();
  assert(typeof first.code === "string" && first.code.length === 6);
  assertEquals((await participantLogin("표여", first.code)).status, 200);

  const second = await (await call("regenerate_code", { id: femaleId })).json();
  assert(second.code !== first.code);

  // Only the newest code authenticates; the server never kept the old one.
  assertEquals((await participantLogin("표여", first.code)).status, 401);
  assertEquals((await participantLogin("표여", second.code)).status, 200);
});

Deno.test("regenerating one code leaves everyone else alone", async () => {
  const maleId = await idOf("표남고침");
  const femaleId = await idOf("표여");
  const male = await (await call("regenerate_code", { id: maleId })).json();
  const female = await (await call("regenerate_code", { id: femaleId })).json();

  const maleAgain = await (await call("regenerate_code", { id: maleId })).json();
  assertEquals((await participantLogin("표남고침", male.code)).status, 401);
  assertEquals((await participantLogin("표남고침", maleAgain.code)).status, 200);
  assertEquals((await participantLogin("표여", female.code)).status, 200);
});

Deno.test("rejects regenerate_code for an unknown participant", async () => {
  const res = await call("regenerate_code", {
    id: "00000000-0000-0000-0000-000000000000",
  });
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "not_found");
});

Deno.test("reissuing a code clears the failure ceiling", async () => {
  // A participant parked at the ceiling is invisible to the sender. The admin
  // fixing their address or reissuing their code is the only way back in, so
  // that action has to reset the counter.
  const id = await sql(
    "select id from participants order by display_name limit 1;",
  );
  await sql(`update participants set send_attempts = 5, send_last_error = 'x' where id = '${id}';`);

  const res = await fetch(`${BASE}/admin-data`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "regenerate_code", id }),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();

  assertEquals(await sql(`select send_attempts from participants where id = '${id}';`), "0");
  assertEquals(await sql(`select send_last_error is null from participants where id = '${id}';`), "t");
});

Deno.test("deletes a participant and their matches go with them", async () => {
  const maleId = await idOf("표남고침");
  const before = await (await call("list_matches")).json();
  const affected = before.matches.filter(
    (m: { maleId: string }) => m.maleId === maleId,
  ).length;
  assert(affected > 0, "expected the participant to have a match");

  const res = await call("delete_participant", { id: maleId });
  assertEquals(res.status, 200);
  await res.body?.cancel();

  const people = await (await call("list_participants")).json();
  assertEquals(
    people.participants.filter((p: { id: string }) => p.id === maleId).length,
    0,
  );

  // on delete cascade removes the match rows too.
  const after = await (await call("list_matches")).json();
  assertEquals(after.matches.length, before.matches.length - affected);
});

Deno.test("rejects a delete for an unknown participant", async () => {
  const res = await call("delete_participant", {
    id: "00000000-0000-0000-0000-000000000000",
  });
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "not_found");
});

Deno.test("regenerates a subset and leaves the rest alone", async () => {
  // seed() re-creates 표남/표여; the rename and delete tests above left the
  // original male row renamed and then removed.
  await seed();
  const femaleId = await idOf("표여");
  const maleId = await idOf("표남");

  const before = {
    male: (await (await call("regenerate_code", { id: maleId })).json()).code,
    female: (await (await call("regenerate_code", { id: femaleId })).json()).code,
  };

  const res = await call("regenerate_codes", { ids: [femaleId] });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.count, 1);
  assert(body.codesCsv.startsWith("이름,성별,연락처,이메일,코드"));

  // Only the listed participant was reissued.
  assertEquals((await participantLogin("표여", before.female)).status, 401);
  assertEquals((await participantLogin("표남", before.male)).status, 200);
});

Deno.test("regenerates everyone when no ids are given", async () => {
  const maleId = await idOf("표남");
  const before = (await (await call("regenerate_code", { id: maleId })).json()).code;
  assertEquals((await participantLogin("표남", before)).status, 200);

  const res = await call("regenerate_codes");
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(body.count >= 2, `expected everyone, got ${body.count}`);

  assertEquals((await participantLogin("표남", before)).status, 401);

  // The returned CSV must carry a working code for each row.
  const lines = body.codesCsv.split("\n").filter((l: string) => l.trim() !== "");
  const first = lines[1].split(",");
  const code = first[first.length - 1];
  assertEquals((await participantLogin(first[0], code)).status, 200);
});

Deno.test("an imported new participant's CSV code works in lookup", async () => {
  await ensureAbsent("신규임포트");
  const row =
    "1부,,소극장,1조,신규임포트,1990-01-01,010-2222-3333,new-import@example.com,표여,1999-05-06,010-0000-0002,b@example.com";
  const res = await importCsv([row]);
  assertEquals(res.status, 200);
  const body = await res.json();
  const codeRow = body.codesCsv
    .split("\n")
    .find((line: string) => line.startsWith("신규임포트,"));
  assert(codeRow, "new participant code row missing");
  const code = codeRow.split(",").at(-1)!;
  assertEquals((await participantLogin("신규임포트", code)).status, 200);
});

Deno.test("selected code reissue keeps the returned CSV code valid", async () => {
  await seed();
  const { maleId, femaleId } = await ids();
  const maleBefore = (await (await call("regenerate_code", { id: maleId })).json()).code;

  const res = await call("regenerate_codes", { ids: [femaleId] });
  assertEquals(res.status, 200);
  const body = await res.json();
  const codeRow = body.codesCsv
    .split("\n")
    .find((line: string) => line.startsWith("표여,"));
  assert(codeRow, "selected participant code row missing");
  const femaleCode = codeRow.split(",").at(-1)!;

  assertEquals((await participantLogin("표여", femaleCode)).status, 200);
  assertEquals((await participantLogin("표남", maleBefore)).status, 200);
});

Deno.test("send_selected_codes sends only the selected participants", async () => {
  await seed();
  const { maleId, femaleId } = await ids();
  const maleBefore = (await (await call("regenerate_code", { id: maleId })).json()).code;
  await armSending(false);

  const sent: { to: string; code: string }[] = [];
  await withBrevo(async (req) => {
    const body = await req.json();
    const html = String(body.htmlContent);
    const code = html.match(/font-size:24px[^>]*>([23456789ABCDEFGHJKMNPQRSTVWXYZ]{6})</)?.[1];
    sent.push({ to: body.to[0].email, code: code ?? "" });
    return new Response(JSON.stringify({ messageId: "selected" }), { status: 201 });
  }, async () => {
    const res = await call("send_selected_codes", { ids: [femaleId] });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.sent, 1);
    assertEquals(body.failed, 0);
  });

  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, "b@example.com");
  assertEquals((await participantLogin("표여", sent[0].code)).status, 200);
  assertEquals((await participantLogin("표남", maleBefore)).status, 200);
});

Deno.test("send_selected_codes rejects while automatic sending is armed", async () => {
  await seed();
  const { femaleId } = await ids();
  await armSending(true);
  try {
    const res = await call("send_selected_codes", { ids: [femaleId] });
    assertEquals(res.status, 409);
    assertEquals((await res.json()).error, "armed_conflict");
  } finally {
    await armSending(false);
  }
});

Deno.test("rejects an empty id list", async () => {
  const res = await call("regenerate_codes", { ids: [] });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_request");
});

Deno.test("reports not_found when no id matches", async () => {
  const res = await call("regenerate_codes", {
    ids: ["00000000-0000-0000-0000-000000000000"],
  });
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "not_found");
});

Deno.test("send_code rejects a request without a code", async () => {
  const id = await idOf("표여");
  const res = await call("send_code", { id });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_request");
});

Deno.test("send_code reports an unknown participant", async () => {
  const res = await call("send_code", {
    id: "00000000-0000-0000-0000-000000000000",
    code: "ABCDEF",
  });
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "not_found");
});

Deno.test("send_code refuses a participant with no email", async () => {
  await ensureAbsent("메일없음");
  const created = await (await call("create_participant", {
    displayName: "메일없음",
    birthdate: "1994-04-04",
    gender: "F",
    contact: "",
    email: "",
  })).json();

  const res = await call("send_code", { id: created.id, code: created.code });
  assertEquals(res.status, 400);
  // Checked before the provider is called: no point spending a send on an
  // address that does not exist.
  assertEquals((await res.json()).error, "no_email");
});

/**
 * Stands in for Brevo. supabase/functions/.env points BREVO_API_URL at this
 * fixed port, so the running function reaches it on every request without any
 * env var crossing the process boundary -- same technique as
 * send-codes/index.test.ts's withBrevo.
 */
async function withBrevo(
  handler: (req: Request) => Response | Promise<Response>,
  body: () => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 8799, signal: controller.signal, onListen: () => {} },
    handler,
  );
  try {
    await body();
  } finally {
    controller.abort();
    await server.finished;
  }
}

/** Arms or disarms automatic sending through send-codes, reusing this file's token. */
async function armSending(armed: boolean): Promise<void> {
  await (
    await fetch(`${BASE}/send-codes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: armed ? "arm" : "disarm" }),
    })
  ).body?.cancel();
}

Deno.test("send_code rejects a code that no longer matches what is stored (F2 stale)", async () => {
  await ensureAbsent("스테일유저");
  const created = await (await call("create_participant", {
    displayName: "스테일유저",
    birthdate: "1993-03-03",
    gender: "F",
    contact: "",
    email: "stale@example.com",
  })).json();
  const shownCode = created.code;

  // Stands in for a concurrent cron tick reissuing this participant's code
  // between the moment the admin's browser fetched shownCode and the moment
  // they click send.
  const reissued = await (await call("regenerate_code", { id: created.id })).json();
  assert(reissued.code !== shownCode);

  const res = await call("send_code", { id: created.id, code: shownCode });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "stale_code");

  // The claim this request took must be released, not left behind, and
  // nothing may have been sent under either code.
  assertEquals(
    await sql(`select send_claim_id is null from participants where id = '${created.id}';`),
    "t",
  );
  assertEquals(
    await sql(`select code_sent_at is null from participants where id = '${created.id}';`),
    "t",
  );
});

Deno.test("send_code refuses while another run holds a live claim (F2 in-progress)", async () => {
  await ensureAbsent("진행중유저");
  const created = await (await call("create_participant", {
    displayName: "진행중유저",
    birthdate: "1993-03-05",
    gender: "M",
    contact: "",
    email: "inprogress@example.com",
  })).json();

  // Stands in for cron's claim_pending_codes having claimed this row moments
  // ago and being mid-send.
  await sql(
    `update participants set send_claim_id = gen_random_uuid(), send_claimed_at = now() where id = '${created.id}';`,
  );

  const res = await call("send_code", { id: created.id, code: created.code });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "send_in_progress");

  // Refused before any send was attempted, so the live claim is untouched --
  // this request must not have released a claim it never took.
  assertEquals(
    await sql(`select send_claim_id is not null from participants where id = '${created.id}';`),
    "t",
  );
});

Deno.test("send_code reclaims a claim older than five minutes and sends normally (F2 happy path)", async () => {
  await ensureAbsent("정상발송");
  const created = await (await call("create_participant", {
    displayName: "정상발송",
    birthdate: "1993-03-06",
    gender: "F",
    contact: "",
    email: "ok@example.com",
  })).json();

  // A claim older than five minutes belonged to a run that died -- the same
  // staleness window claim_pending_codes uses. It must not block a fresh
  // manual send.
  await sql(
    `update participants set send_claim_id = gen_random_uuid(), send_claimed_at = now() - interval '6 minutes' where id = '${created.id}';`,
  );

  await withBrevo(
    () => new Response("{}", { status: 201 }),
    async () => {
      const res = await call("send_code", { id: created.id, code: created.code });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.ok, true);
      assertEquals(body.email, "ok@example.com");
    },
  );

  assertEquals(
    await sql(`select code_sent_at is not null from participants where id = '${created.id}';`),
    "t",
  );
  assertEquals(
    await sql(`select send_claim_id is null from participants where id = '${created.id}';`),
    "t",
  );
});

Deno.test("send_code releases its claim even when the stamp write errors (R2)", async () => {
  await ensureAbsent("스탬프실패");
  const created = await (await call("create_participant", {
    displayName: "스탬프실패",
    birthdate: "1993-03-09",
    gender: "F",
    contact: "",
    email: "stampfail@example.com",
  })).json();

  // Fires only on the write stamp() makes -- the one that sets code_sent_at
  // -- so the claim update that precedes it is untouched. Stands in for a
  // transient DB fault on that specific write, the exact path F["stampError"]
  // in send_code covers: send succeeds, but the write that was supposed to
  // clear the claim comes back with an error instead.
  await sql(`
    create or replace function test_break_stamp() returns trigger as $$
    begin
      raise exception 'induced stamp failure for test';
    end;
    $$ language plpgsql;
  `);
  await sql(
    `create trigger break_stamp before update of code_sent_at on participants ` +
      `for each row when (new.id = '${created.id}') execute function test_break_stamp();`,
  );

  try {
    await withBrevo(
      () => new Response("{}", { status: 201 }),
      async () => {
        const res = await call("send_code", { id: created.id, code: created.code });
        // The mail already went out (the stub above accepted it), so the
        // request still reports success even though the write behind it
        // failed -- send_code's own documented behaviour when stamping fails.
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.ok, true);
      },
    );
  } finally {
    await sql("drop trigger if exists break_stamp on participants;");
    await sql("drop function if exists test_break_stamp();");
  }

  // The point of this test: without the try/finally fix, this claim would
  // still be held by the dead request and this row would be invisible to
  // both the automatic sender and a retried manual send for a full five
  // minutes -- and, per the code's own comment, mailed a duplicate code
  // later since code_sent_at never got set either.
  assertEquals(
    await sql(`select send_claim_id is null from participants where id = '${created.id}';`),
    "t",
  );
  assertEquals(
    await sql(`select code_sent_at is null from participants where id = '${created.id}';`),
    "t",
  );
});

Deno.test("send_code releases its claim when sendCodeEmail throws (R2)", async () => {
  await ensureAbsent("발송예외");
  const created = await (await call("create_participant", {
    displayName: "발송예외",
    birthdate: "1993-03-10",
    gender: "M",
    contact: "",
    email: "exception@example.com",
  })).json();

  await withBrevo(
    () =>
      // sendCodeEmail wraps only the fetch() call itself in try/catch; the
      // `!res.ok` branch right after it reads the body with a bare
      // `await res.text()`. A body stream that errors mid-read makes that
      // await throw a genuine exception out of sendCodeEmail, through
      // send_code, past the point where the claim was taken -- exactly the
      // "thrown exception between claiming and releasing" this fix guards,
      // as opposed to a returned SendResult the code already branches on.
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("induced stream failure for test"));
          },
        }),
        { status: 500 },
      ),
    async () => {
      const res = await call("send_code", { id: created.id, code: created.code });
      // Nothing here catches the exception, so it reaches Deno.serve's
      // default handler and comes back as a plain 500 rather than one of
      // send_code's own { error } bodies. What matters is not this status
      // code but that the claim was not left behind on the way there.
      assertEquals(res.status, 500);
      await res.body?.cancel();
    },
  );

  assertEquals(
    await sql(`select send_claim_id is null from participants where id = '${created.id}';`),
    "t",
  );
  assertEquals(
    await sql(`select code_sent_at is null from participants where id = '${created.id}';`),
    "t",
  );
});

Deno.test("send_code rejects a malformed code before touching the row (F8)", async () => {
  await ensureAbsent("포맷불량");
  const created = await (await call("create_participant", {
    displayName: "포맷불량",
    birthdate: "1993-03-07",
    gender: "M",
    contact: "",
    email: "badformat@example.com",
  })).json();

  const res = await call("send_code", {
    id: created.id,
    code: "<img src=x onerror=alert(1)>",
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_request");

  // Rejected before any claim was taken.
  assertEquals(
    await sql(`select send_claim_id is null from participants where id = '${created.id}';`),
    "t",
  );
});

Deno.test("update_participant preserves an in-flight claim when the email is unchanged (F4)", async () => {
  await ensureAbsent("클레임유지");
  const created = await (await call("create_participant", {
    displayName: "클레임유지",
    birthdate: "1993-03-08",
    gender: "F",
    contact: "",
    email: "keep@example.com",
  })).json();

  const claimId = crypto.randomUUID();
  await sql(
    `update participants set send_claim_id = '${claimId}', send_claimed_at = now() where id = '${created.id}';`,
  );

  const res = await call("update_participant", {
    id: created.id,
    displayName: "클레임유지",
    birthdate: "1993-03-08",
    gender: "F",
    contact: "010-1234-5678",
    email: "keep@example.com",
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();

  // Unchanged: the in-flight send is still going to the right address, so
  // cancelling it would only produce a redundant second mail.
  assertEquals(
    await sql(`select send_claim_id from participants where id = '${created.id}';`),
    claimId,
  );
});

Deno.test("update_participant abandons an in-flight claim when the email changes (F4)", async () => {
  await ensureAbsent("클레임취소");
  const created = await (await call("create_participant", {
    displayName: "클레임취소",
    birthdate: "1993-03-09",
    gender: "M",
    contact: "",
    email: "typo@example.com",
  })).json();

  await sql(
    `update participants set send_claim_id = gen_random_uuid(), send_claimed_at = now() where id = '${created.id}';`,
  );

  const res = await call("update_participant", {
    id: created.id,
    displayName: "클레임취소",
    birthdate: "1993-03-09",
    gender: "M",
    contact: "",
    email: "fixed@example.com",
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();

  // Changed: the in-flight send is going to the WRONG address now, so it must
  // be abandoned so the row stays pending and is re-sent to the new address.
  assertEquals(
    await sql(`select send_claim_id is null from participants where id = '${created.id}';`),
    "t",
  );
});

/** Uploads a small CSV built from HEADER plus the given data rows. */
async function importCsv(rows: string[]): Promise<Response> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([[HEADER, ...rows].join("\n")], { type: "text/csv" }),
    "matches.csv",
  );
  return await fetch(`${BASE}/admin-import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}` },
    body: form,
  });
}

Deno.test("re-importing with the code and email both unchanged preserves an in-flight claim (F5 control)", async () => {
  const row =
    "1부,,소극장,1조,메일고정남,1988-08-08,010-1111-1111,fix-control@example.com,메일고정여,1988-08-09,010-1111-1112,fixpartner-control@example.com";
  await (await importCsv([row])).body?.cancel();

  const id = await idOf("메일고정남");
  const claimId = crypto.randomUUID();
  await sql(
    `update participants set send_claim_id = '${claimId}', send_claimed_at = now() where id = '${id}';`,
  );

  // Re-imported with only a harmless contact tweak -- code and email both
  // stay exactly the same, so ...0011's original reasoning still applies: a
  // run mid-flight sending the current code to the current address must be
  // left alone.
  const rowAgain = row.replace("010-1111-1111", "010-2222-2222");
  await (await importCsv([rowAgain])).body?.cancel();

  assertEquals(await sql(`select send_claim_id from participants where id = '${id}';`), claimId);
});

Deno.test("re-importing a corrected email abandons an in-flight claim (F5)", async () => {
  const row =
    "1부,,소극장,1조,메일고침남,1988-08-10,010-3333-3333,typo@example.con,메일고침여,1988-08-11,010-3333-3334,fixpartner2@example.com";
  await (await importCsv([row])).body?.cancel();

  const id = await idOf("메일고침남");
  // Stands in for a run mid-flight, currently holding the OLD (typo'd)
  // address in memory.
  await sql(
    `update participants set send_claim_id = gen_random_uuid(), send_claimed_at = now() where id = '${id}';`,
  );

  const corrected = row.replace("typo@example.con", "typo@example.com");
  await (await importCsv([corrected])).body?.cancel();

  // The claim must be gone: left in place, the in-flight run's stamp() would
  // still succeed under the old address and mark this row done while the
  // corrected address never got a code.
  assertEquals(await sql(`select send_claim_id is null from participants where id = '${id}';`), "t");
  // code_sent_at is deliberately untouched by an address-only fix -- see the
  // migration's comment -- and the attempt/error resets stay unconditional
  // regardless of what changed.
  assertEquals(await sql(`select send_attempts from participants where id = '${id}';`), "0");
});

Deno.test("regenerate_codes (bulk) refuses while automatic sending is armed (F7)", async () => {
  await seed();
  const { maleId } = await ids();
  const before = (await (await call("regenerate_code", { id: maleId })).json()).code;

  await armSending(true);
  try {
    const subset = await call("regenerate_codes", { ids: [maleId] });
    assertEquals(subset.status, 409);
    assertEquals((await subset.json()).error, "armed_conflict");

    const everyone = await call("regenerate_codes");
    assertEquals(everyone.status, 409);
    assertEquals((await everyone.json()).error, "armed_conflict");
  } finally {
    await armSending(false);
  }

  // Nothing was actually reissued: the code from before the armed check
  // still authenticates.
  assertEquals((await participantLogin("표남", before)).status, 200);
});

Deno.test("regenerate_code (single) still works while armed -- F2 makes it safe (F7)", async () => {
  const maleId = await idOf("표남");

  await armSending(true);
  let reissuedCode: string;
  try {
    const res = await call("regenerate_code", { id: maleId });
    assertEquals(res.status, 200);
    reissuedCode = (await res.json()).code;
  } finally {
    await armSending(false);
  }

  assertEquals((await participantLogin("표남", reissuedCode!)).status, 200);
});
