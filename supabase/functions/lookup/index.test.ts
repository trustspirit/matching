import { assert, assertEquals } from "jsr:@std/assert@1";

const BASE = Deno.env.get("FUNCTIONS_URL") ?? "http://127.0.0.1:54321/functions/v1";

async function lookup(name: string, code: string): Promise<Response> {
  return await fetch(`${BASE}/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, code }),
  });
}

Deno.test("returns the participant's match on a correct name and code", async () => {
  const res = await lookup("김효준", "TES-TA2");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.displayName, "김효준");
  assertEquals(body.matches.length, 1);
  assertEquals(body.matches[0].session, "1부");
  assertEquals(body.matches[0].venue, "소극장");
  assertEquals(body.matches[0].team, "3조");
  assertEquals(body.matches[0].partnerName, "정예림");
  assertEquals(body.matches[0].arriveBy, "21:50");
});

Deno.test("accepts a code in any casing or spacing", async () => {
  const res = await lookup(" 김 효 준 ", "tes ta2");
  assertEquals(res.status, 200);
});

Deno.test("returns both matches for a participant attending twice", async () => {
  const res = await lookup("윤모습", "TESTA5");
  const body = await res.json();
  assertEquals(body.matches.length, 2);
  const sessions = body.matches.map((m: { session: string }) => m.session).sort();
  assertEquals(sessions, ["1부", "2부"]);
});

Deno.test("returns null team when the team is undecided", async () => {
  const res = await lookup("박한서", "TESTA4");
  const body = await res.json();
  assertEquals(body.matches[0].team, null);
});

Deno.test("returns an empty list for a participant with no match", async () => {
  const res = await lookup("이승준", "TESTAC");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.matches, []);
});

Deno.test("keeps same-name participants separated by code", async () => {
  const first = await (await lookup("김시현", "TESTA7")).json();
  const second = await (await lookup("김시현", "TESTA8")).json();
  assertEquals(first.matches[0].partnerName, "윤해서");
  assertEquals(second.matches[0].partnerName, "김은해");
});

Deno.test("rejects a wrong code for an existing name", async () => {
  const res = await lookup("김효준", "TESTAZ");
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "invalid_credentials");
});

Deno.test("responds identically for an unknown name and a wrong code", async () => {
  const unknown = await lookup("존재하지않는사람", "TESTA2");
  const wrongCode = await lookup("김효준", "TESTAZ");
  assertEquals(unknown.status, wrongCode.status);
  assertEquals(await unknown.json(), await wrongCode.json());
});

Deno.test("rejects a malformed code before touching the database", async () => {
  const res = await lookup("김효준", "K7M2Q0"); // 0 is not in the alphabet
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_request");
});

Deno.test("rejects an empty name", async () => {
  const res = await lookup("   ", "TESTA2");
  assertEquals(res.status, 400);
});

Deno.test("throttles after five failures from the same address", async () => {
  // Clear the window by using a distinct forwarded address for this test.
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  const attempt = () =>
    fetch(`${BASE}/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ name: "김효준", code: "TESTAZ" }),
    });

  for (let i = 0; i < 5; i++) {
    assertEquals((await attempt()).status, 401);
  }
  const sixth = await attempt();
  assertEquals(sixth.status, 429);
  const body = await sixth.json();
  assertEquals(body.error, "too_many_attempts");
  assert(typeof body.retryAfter === "number");
});

Deno.test("answers CORS preflight", async () => {
  const res = await fetch(`${BASE}/lookup`, { method: "OPTIONS" });
  assertEquals(res.status, 204);
  await res.body?.cancel();
});
