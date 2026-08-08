import { describe, expect, it } from "vitest";
import { nameMatches } from "./nameFilter";

describe("nameMatches", () => {
  it("matches a substring of the name", () => {
    expect(nameMatches("철수", "김철수")).toBe(true);
    expect(nameMatches("김", "김철수")).toBe(true);
  });

  it("does not match an unrelated name", () => {
    expect(nameMatches("영희", "김철수")).toBe(false);
  });

  it("matches everything while the box is empty", () => {
    // The caller passes the input value straight through, so a cleared box has
    // to mean "no filter" rather than "nothing matches".
    expect(nameMatches("", "김철수")).toBe(true);
    expect(nameMatches("   ", "김철수")).toBe(true);
  });

  it("ignores whitespace on both sides", () => {
    expect(nameMatches("김 철수", "김철수")).toBe(true);
    expect(nameMatches("김철수", "김 철수")).toBe(true);
  });

  it("ignores case for latin names", () => {
    expect(nameMatches("seung", "Lee Seungho")).toBe(true);
  });

  it("treats decomposed hangul as equal to composed", () => {
    // A paste from some sources arrives in NFD; without normalising, the two
    // forms compare unequal despite looking identical.
    const composed = "김철수";
    expect(nameMatches(composed.normalize("NFD"), composed)).toBe(true);
  });

  it("matches when any of several names hits", () => {
    // A match row is searched by either partner's name.
    expect(nameMatches("영희", "김철수", "이영희")).toBe(true);
  });

  it("skips names that are absent", () => {
    expect(nameMatches("김", null, undefined)).toBe(false);
  });
});
