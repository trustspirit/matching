import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { hashHex, timingSafeEqual } from "./hash.ts";

Deno.test("hashHex is deterministic", async () => {
  assertEquals(await hashHex("token"), await hashHex("token"));
});

Deno.test("hashHex differs when the input differs", async () => {
  assertNotEquals(await hashHex("token"), await hashHex("token "));
});

Deno.test("hashHex returns 64 hex characters", async () => {
  assert(/^[0-9a-f]{64}$/.test(await hashHex("token")));
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
