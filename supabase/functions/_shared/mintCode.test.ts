import { assert, assertEquals } from "jsr:@std/assert@1";
import { isValidCode } from "./lib/code.ts";
import { mintUniqueCode } from "./mintCode.ts";

Deno.test("mints a usable code", () => {
  assert(isValidCode(mintUniqueCode(new Set())));
});

Deno.test("never returns a code already taken", () => {
  const target = mintUniqueCode(new Set());
  // 200 draws with one code taken: none of them may equal it.
  for (let i = 0; i < 200; i++) {
    assert(mintUniqueCode(new Set([target])) !== target);
  }
});

Deno.test("a batch does not collide with itself", () => {
  // The caller does not have to remember to record what it drew: minting adds
  // to the set, which is what makes a loop like this safe.
  const taken = new Set<string>();
  for (let i = 0; i < 300; i++) mintUniqueCode(taken);
  assertEquals(taken.size, 300);
});
