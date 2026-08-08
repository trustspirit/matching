import { assert, assertEquals } from "jsr:@std/assert@1";

const BASE = Deno.env.get("FUNCTIONS_URL") ?? "http://127.0.0.1:54321/functions/v1";
const PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "local-admin";

const HEADER =
  "부,시간,장소,조,남성 이름,남성 생년월일,남성 연락처,남성 이메일,여성 이름,여성 생년월일,여성 연락처,여성 이메일";
const ROW_A =
  "1부,,소극장,3조,표남,1999-01-02,010-0000-0001,a@example.com,표여,1999-05-06,010-0000-0002,b@example.com";

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
    headers: { Authorization: `Bearer ${PASSWORD}` },
    body: form,
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
}

async function call(
  action: string,
  params: Record<string, unknown> = {},
  password = PASSWORD,
): Promise<Response> {
  return await fetch(`${BASE}/admin-data`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${password}`,
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

Deno.test("rejects a wrong password", async () => {
  const res = await call("list_matches", {}, "nope");
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "unauthorized");
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
