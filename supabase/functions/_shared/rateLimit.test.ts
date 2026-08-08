import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { ADMIN_POLICY, hashIp, PARTICIPANT_POLICY } from "./rateLimit.ts";

Deno.test("hashIp is stable for the same ip and salt", async () => {
  const a = await hashIp("203.0.113.5", "abc123");
  const b = await hashIp("203.0.113.5", "abc123");
  assertEquals(a, b);
});

Deno.test("hashIp changes when the salt changes", async () => {
  const a = await hashIp("203.0.113.5", "salt-one");
  const b = await hashIp("203.0.113.5", "salt-two");
  assertNotEquals(a, b);
});

Deno.test("hashIp changes when the ip changes", async () => {
  const a = await hashIp("203.0.113.5", "abc123");
  const b = await hashIp("203.0.113.6", "abc123");
  assertNotEquals(a, b);
});

Deno.test("hashIp returns a full sha256 hex digest", async () => {
  const digest = await hashIp("203.0.113.5", "abc123");
  assertEquals(digest.length, 64);
  assert(/^[0-9a-f]+$/.test(digest));
});

Deno.test("participant policy keeps the existing thresholds", () => {
  assertEquals(PARTICIPANT_POLICY.table, "login_attempts");
  assertEquals(PARTICIPANT_POLICY.windowMs, 60_000);
  assertEquals(PARTICIPANT_POLICY.maxFailures, 30);
  assertEquals(PARTICIPANT_POLICY.succeededColumn, "succeeded");
});

Deno.test("admin policy is stricter and uses its own table", () => {
  assertEquals(ADMIN_POLICY.table, "admin_attempts");
  assertEquals(ADMIN_POLICY.windowMs, 900_000);
  assertEquals(ADMIN_POLICY.maxFailures, 10);
  assertEquals(ADMIN_POLICY.succeededColumn, null);
});

Deno.test("the two policies never share a table", () => {
  assertNotEquals(PARTICIPANT_POLICY.table, ADMIN_POLICY.table);
});
