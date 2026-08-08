import { describe, expect, it } from "vitest";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  generateCode,
  isValidCode,
  normalizeCode,
} from "./code.ts";

describe("CODE_ALPHABET", () => {
  it("excludes characters that are easy to misread by hand", () => {
    for (const ch of "01ILOU") {
      expect(CODE_ALPHABET).not.toContain(ch);
    }
  });

  it("has no duplicate characters", () => {
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
  });
});

describe("generateCode", () => {
  it("returns a code of the configured length", () => {
    expect(generateCode()).toHaveLength(CODE_LENGTH);
  });

  it("only uses characters from the alphabet", () => {
    for (let i = 0; i < 500; i++) {
      for (const ch of generateCode()) {
        expect(CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it("draws every character of the alphabet", () => {
    // 2000 draws is 12000 characters over 30 symbols. A symbol never appearing
    // has probability ~30*(29/30)^12000, which is astronomically small, so this
    // is deterministic in practice. A biased RNG that never reaches the top of
    // the range fails here.
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      for (const ch of generateCode()) seen.add(ch);
    }
    expect(seen.size).toBe(CODE_ALPHABET.length);
  });

  it("produces near-distinct codes across 10k draws", () => {
    // Birthday paradox: with 30^6 (~729M) possible codes, 10k draws are
    // *expected* to collide about 0.07 times. Asserting zero collisions would
    // be flaky; allowing 10 keeps the test deterministic while still catching
    // an RNG that has collapsed to a small range.
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateCode());
    expect(seen.size).toBeGreaterThanOrEqual(9_990);
  });

  it("accepts an injected integer source for deterministic tests", () => {
    let n = 0;
    const code = generateCode(() => n++);
    expect(code).toBe(CODE_ALPHABET.slice(0, CODE_LENGTH));
  });
});

describe("normalizeCode", () => {
  it("upper-cases and strips separators", () => {
    for (const input of ["k7m-2qx", "K7M 2QX", "k7m2qx", " K7M–2QX "]) {
      expect(normalizeCode(input)).toBe("K7M2QX");
    }
  });

  it("returns an empty string for input with no alphanumerics", () => {
    expect(normalizeCode("---")).toBe("");
  });
});

describe("isValidCode", () => {
  it("accepts a well-formed code in any casing or spacing", () => {
    expect(isValidCode("k7m-2qx")).toBe(true);
  });

  it("rejects the wrong length", () => {
    expect(isValidCode("K7M2Q")).toBe(false);
    expect(isValidCode("K7M2QXA")).toBe(false);
  });

  it("rejects characters outside the alphabet", () => {
    // 0, 1, I, L, O, U are deliberately not in the alphabet.
    expect(isValidCode("K7M2Q0")).toBe(false);
    expect(isValidCode("K7M2QI")).toBe(false);
  });
});
