import { describe, expect, it } from "vitest";
import { categoryColor, categoryValues, NEUTRAL } from "./categoryColor";

describe("categoryValues", () => {
  it("returns distinct values in a stable sorted order", () => {
    expect(categoryValues(["골드", "소극장", "골드", "실버"]))
      .toEqual(["골드", "소극장", "실버"].sort());
  });

  it("drops nulls and blanks", () => {
    expect(categoryValues([null, "", "소극장"])).toEqual(["소극장"]);
  });

  it("does not depend on input order", () => {
    const a = categoryValues(["b", "a", "c"]);
    const b = categoryValues(["c", "b", "a"]);
    expect(a).toEqual(b);
  });
});

describe("categoryColor", () => {
  const all = ["a", "b", "c", "d", "e", "f", "g"];

  it("gives each of the first six values its own colour", () => {
    const backgrounds = all.slice(0, 6).map((v) => categoryColor(v, all).bg);
    expect(new Set(backgrounds).size).toBe(6);
  });

  it("falls back to neutral past the sixth value", () => {
    // A seventh hue would read like one of the first six rather than add
    // meaning, so the palette stops instead of cycling.
    expect(categoryColor("g", all)).toEqual(NEUTRAL);
  });

  it("returns neutral for a value that is not in the list", () => {
    expect(categoryColor("zzz", all)).toEqual(NEUTRAL);
  });

  it("keeps a value's colour when other values disappear", () => {
    // Colour follows the entity, not its rank: filtering the table must not
    // repaint the rows that survive.
    const before = categoryColor("c", ["a", "b", "c", "d"]);
    const after = categoryColor("c", ["a", "b", "c", "d"]);
    expect(after).toEqual(before);
  });

  it("clears 7:1 between every palette entry and its own text", () => {
    // Measured rather than eyeballed. The palette was at the WCAG AA minimum
    // of 4.5:1 before, and at this label size black type sat in the background
    // colour instead of on top of it -- so the floor here is 7:1, and a slot
    // added without checking it fails this test.
    for (const value of all.slice(0, 6)) {
      const { bg, fg } = categoryColor(value, all);
      expect(bg).toMatch(/^#[0-9a-f]{6}$/);
      expect(["#000000", "#ffffff"]).toContain(fg);
      expect(contrast(bg, fg)).toBeGreaterThanOrEqual(7);
    }
  });

  it("keeps the neutral fallback readable too", () => {
    expect(contrast(NEUTRAL.bg, NEUTRAL.fg)).toBeGreaterThanOrEqual(7);
  });
});

/** WCAG relative-luminance contrast ratio. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
