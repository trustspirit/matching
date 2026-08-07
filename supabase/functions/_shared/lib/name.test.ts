import { describe, expect, it } from "vitest";
import { NAME_ALIASES, normalizeName } from "./name.ts";

describe("normalizeName", () => {
  it("strips all whitespace", () => {
    expect(normalizeName(" 김 효 준 ")).toBe("김효준");
  });

  it("converts decomposed Hangul to the composed form", () => {
    // NFD "김" (ᄀ + ᅵ + ᆷ) must land on the same value as NFC "김".
    const decomposed = "김".normalize("NFD");
    expect(decomposed).not.toBe("김");
    expect(normalizeName(decomposed)).toBe(normalizeName("김"));
  });

  it("lower-cases Latin names so casing variants collapse", () => {
    expect(normalizeName("Flores, Romrik Joshua"))
      .toBe(normalizeName("flores,romrikjoshua"));
  });

  it("maps a known alias to its canonical name", () => {
    // Same person entered twice with different spellings in the source sheet.
    expect(normalizeName("이승호- lee Seung ho")).toBe("이승호");
    expect(normalizeName("이승호")).toBe("이승호");
  });

  it("leaves names that are not aliases untouched", () => {
    expect(normalizeName("정예림")).toBe("정예림");
  });

  it("keys the alias table by already-normalized names", () => {
    // A stale key would silently never match, so assert the invariant directly.
    for (const key of Object.keys(NAME_ALIASES)) {
      expect(key).toBe(key.normalize("NFC").replace(/\s+/g, "").toLowerCase());
    }
  });
});
