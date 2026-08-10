import { assert, assertEquals } from "jsr:@std/assert@1";

const BASE = Deno.env.get("FUNCTIONS_URL") ?? "http://127.0.0.1:54321/functions/v1";

/** Login takes the code alone; the name is no longer part of the credential. */
async function lookup(code: string): Promise<Response> {
  return await fetch(`${BASE}/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

Deno.test("returns the participant's match for a correct code", async () => {
  const res = await lookup("TES-TA2");
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
  const res = await lookup("tes ta2");
  assertEquals(res.status, 200);
});

Deno.test("returns both matches for a participant attending twice", async () => {
  const res = await lookup("TESTA5");
  const body = await res.json();
  assertEquals(body.matches.length, 2);
  const sessions = body.matches.map((m: { session: string }) => m.session).sort();
  assertEquals(sessions, ["1부", "2부"]);
});

Deno.test("returns each side its own 조 when the pair sits in different ones", async () => {
  // Seed 1부/실버 pairs 엄태건 (1조) with 윤모습 (6조).
  const male = await (await lookup("TESTA6")).json();
  assertEquals(male.matches[0].team, "1조");

  const female = await (await lookup("TESTA5")).json();
  const silver = female.matches.find((m: { venue: string }) => m.venue === "실버");
  assertEquals(silver.team, "6조");
});

Deno.test("returns null team when the team is undecided", async () => {
  const res = await lookup("TESTA4");
  const body = await res.json();
  assertEquals(body.matches[0].team, null);
});

Deno.test("returns an empty list for a participant with no match", async () => {
  const res = await lookup("TESTAC");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.matches, []);
});

Deno.test("tells participants who share a name apart by code", async () => {
  const first = await (await lookup("TESTA7")).json();
  const second = await (await lookup("TESTA8")).json();
  assertEquals(first.matches[0].partnerName, "윤해서");
  assertEquals(second.matches[0].partnerName, "김은해");
});

Deno.test("rejects a code nobody holds", async () => {
  const res = await lookup("TESTAZ");
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "invalid_credentials");
});

Deno.test("rejects a well-formed code that belongs to no one", async () => {
  // Two different unused codes must be indistinguishable from each other:
  // nothing in the response may hint at how close a guess was.
  const a = await lookup("TESTAZ");
  const b = await lookup("TESTAY");
  assertEquals(a.status, b.status);
  assertEquals(await a.json(), await b.json());
});

Deno.test("rejects a malformed code before touching the database", async () => {
  const res = await lookup("K7M2Q0"); // 0 is not in the alphabet
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_request");
});

Deno.test("rejects a missing code", async () => {
  const res = await fetch(`${BASE}/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_request");
});

Deno.test("throttles after MAX_FAILURES_PER_WINDOW failures from the same address", async () => {
  // Clear the window by using a distinct forwarded address for this test.
  // 30 matches _shared/rateLimit.ts's MAX_FAILURES_PER_WINDOW; kept as a
  // literal here (not imported) so this test fails loudly if the two drift.
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  const attempt = () =>
    fetch(`${BASE}/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ code: "TESTAZ" }),
    });

  for (let i = 0; i < 30; i++) {
    assertEquals((await attempt()).status, 401);
  }
  const next = await attempt();
  assertEquals(next.status, 429);
  const body = await next.json();
  assertEquals(body.error, "too_many_attempts");
  assert(typeof body.retryAfter === "number");
});

Deno.test("answers CORS preflight", async () => {
  const res = await fetch(`${BASE}/lookup`, { method: "OPTIONS" });
  assertEquals(res.status, 204);
  await res.body?.cancel();
});
