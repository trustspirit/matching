import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { hashIp } from "./rateLimit.ts";

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
