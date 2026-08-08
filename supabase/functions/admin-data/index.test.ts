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
  assertEquals(row.team, "3조");
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
    team: "9조",
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
  assertEquals(found.team, "9조");
});

Deno.test("rejects a match with a blank time range", async () => {
  const { maleId, femaleId } = await ids();
  const res = await call("create_match", {
    session: "1부",
    timeRange: "",
    arriveBy: "21:50",
    venue: "소극장",
    team: "1조",
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
    team: "7조",
    maleId: row.maleId,
    femaleId: row.femaleId,
  });
  assertEquals(res.status, 200);

  const after = await (await call("list_matches")).json();
  const updated = after.matches.find((m: { id: string }) => m.id === row.id);
  assertEquals(updated.team, "7조");
});

Deno.test("clears the team when it is sent empty", async () => {
  const list = await (await call("list_matches")).json();
  const row = list.matches.find((m: { team: string | null }) => m.team === "7조");
  assert(row);

  const res = await call("update_match", { ...row, team: "" });
  assertEquals(res.status, 200);
  await res.body?.cancel();

  const after = await (await call("list_matches")).json();
  const updated = after.matches.find((m: { id: string }) => m.id === row.id);
  // An empty team means "not assigned yet", stored as NULL so the participant
  // screen can show "조 배정 예정".
  assertEquals(updated.team, null);
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
  const created = await (await call("create_participant", {
    displayName: "영향없음",
    birthdate: "1995-05-05",
    gender: "M",
    contact: "",
    email: "",
  })).json();

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

/** Logs in as a participant to prove a code works. */
async function participantLogin(name: string, code: string): Promise<Response> {
  return await fetch(`${BASE}/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, code }),
  });
}

Deno.test("creates a participant and the returned code works", async () => {
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

  // The new name works, the old one does not: `name` was normalized and
  // stored alongside `display_name`.
  assertEquals((await participantLogin("표남고침", reissued.code)).status, 200);
  assertEquals((await participantLogin("표남", reissued.code)).status, 401);

  const list = await (await call("list_participants")).json();
  const row = list.participants.find((p: { id: string }) => p.id === maleId);
  assertEquals(row.displayName, "표남고침");
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
