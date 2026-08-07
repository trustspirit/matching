import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { DUMMY_SALT, hashCode, randomSalt, timingSafeEqual } from "./hash.ts";

Deno.test("randomSalt returns 32 hex characters", () => {
  assertEquals(randomSalt().length, 32);
  assert(/^[0-9a-f]{32}$/.test(randomSalt()));
});

Deno.test("randomSalt does not repeat", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(randomSalt());
  assertEquals(seen.size, 1000);
});

Deno.test("hashCode is deterministic for the same salt and code", async () => {
  const salt = randomSalt();
  assertEquals(await hashCode(salt, "K7M2QX"), await hashCode(salt, "K7M2QX"));
});

Deno.test("hashCode differs when the salt differs", async () => {
  assertNotEquals(
    await hashCode("aaaa", "K7M2QX"),
    await hashCode("bbbb", "K7M2QX"),
  );
});

Deno.test("hashCode differs when the code differs", async () => {
  const salt = randomSalt();
  assertNotEquals(await hashCode(salt, "K7M2QX"), await hashCode(salt, "K7M2QY"));
});

Deno.test("hashCode returns 64 hex characters", async () => {
  assert(/^[0-9a-f]{64}$/.test(await hashCode("s", "K7M2QX")));
});

Deno.test("timingSafeEqual matches identical strings", () => {
  assertEquals(timingSafeEqual("abc", "abc"), true);
});

Deno.test("timingSafeEqual rejects different strings of equal length", () => {
  assertEquals(timingSafeEqual("abc", "abd"), false);
});

Deno.test("timingSafeEqual rejects different lengths", () => {
  assertEquals(timingSafeEqual("abc", "abcd"), false);
});

Deno.test("DUMMY_SALT is usable for timing equalization", async () => {
  assert(DUMMY_SALT.length > 0);
  assert(/^[0-9a-f]{64}$/.test(await hashCode(DUMMY_SALT, "K7M2QX")));
});
