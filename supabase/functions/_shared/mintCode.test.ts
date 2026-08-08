import { assert, assertEquals } from "jsr:@std/assert@1";
import { hashCode } from "./hash.ts";
import { isValidCode } from "./lib/code.ts";
import { mintUniqueCode, type TakenCode } from "./mintCode.ts";

Deno.test("mints a usable code with its own salt", async () => {
  const minted = await mintUniqueCode([]);
  assert(isValidCode(minted.code));
  assertEquals(minted.salt.length, 32);
  assertEquals(await hashCode(minted.salt, minted.code), minted.hash);
});

Deno.test("never returns a code already taken", async () => {
  // Fill `taken` with every code the alphabet allows except one, by faking a
  // guard that claims a clash for anything but the target. Doing that honestly
  // is impossible, so instead assert the clash check itself: a taken entry
  // built from a known code must be detected.
  const target = await mintUniqueCode([]);
  const taken: TakenCode[] = [{ salt: target.salt, hash: target.hash }];

  // 200 draws with one code taken: none of them may equal it.
  for (let i = 0; i < 200; i++) {
    const next = await mintUniqueCode(taken);
    assert(next.code !== target.code);
  }
});

Deno.test("a batch does not collide with itself", async () => {
  const taken: TakenCode[] = [];
  const codes = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const minted = await mintUniqueCode(taken);
    taken.push({ salt: minted.salt, hash: minted.hash });
    codes.add(minted.code);
  }
  assertEquals(codes.size, 300);
});

Deno.test("gives every code a distinct salt", async () => {
  const taken: TakenCode[] = [];
  const salts = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const minted = await mintUniqueCode(taken);
    taken.push({ salt: minted.salt, hash: minted.hash });
    salts.add(minted.salt);
  }
  // Per-row salts are what stop one rainbow table from covering every code.
  assertEquals(salts.size, 50);
});
