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
