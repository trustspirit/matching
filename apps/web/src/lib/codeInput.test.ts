import { describe, expect, it } from "vitest";
import { acceptChar, distributePaste, nextFocusIndex } from "./codeInput";

describe("acceptChar", () => {
  it("accepts an alphabet character as-is", () => {
    expect(acceptChar("K")).toBe("K");
  });

  it("upper-cases a lower-case alphabet character", () => {
    expect(acceptChar("k")).toBe("K");
  });

  it("rejects characters excluded from the alphabet", () => {
    // 0/1/I/L/O/U are excluded so codes survive being copied by hand.
    for (const ch of "01ILOU") {
      expect(acceptChar(ch)).toBeNull();
    }
  });

  it("rejects punctuation and spaces", () => {
    expect(acceptChar("-")).toBeNull();
    expect(acceptChar(" ")).toBeNull();
  });

  it("rejects an empty or multi-character input", () => {
    expect(acceptChar("")).toBeNull();
    expect(acceptChar("KJ")).toBeNull();
  });
});

describe("distributePaste", () => {
  const empty = ["", "", "", "", "", ""];

  it("fills every cell from a full code", () => {
    expect(distributePaste("K7M2QX", 0, empty)).toEqual(
      ["K", "7", "M", "2", "Q", "X"],
    );
  });

  it("strips a hyphen before distributing", () => {
    // Codes handed out before this change were printed as K7M-2QX.
    expect(distributePaste("K7M-2QX", 0, empty)).toEqual(
      ["K", "7", "M", "2", "Q", "X"],
    );
  });

  it("upper-cases a lower-case paste", () => {
    expect(distributePaste("k7m2qx", 0, empty)).toEqual(
      ["K", "7", "M", "2", "Q", "X"],
    );
  });

  it("starts at the given index and leaves earlier cells alone", () => {
    const current = ["A", "B", "", "", "", ""];
    expect(distributePaste("K7", 2, current)).toEqual(
      ["A", "B", "K", "7", "", ""],
    );
  });

  it("ignores characters past the last cell", () => {
    expect(distributePaste("K7M2QXZZZ", 0, empty)).toEqual(
      ["K", "7", "M", "2", "Q", "X"],
    );
  });

  it("returns a new array without mutating the input", () => {
    const current = [...empty];
    const result = distributePaste("K", 0, current);
    expect(current).toEqual(empty);
    expect(result).not.toBe(current);
  });

  it("returns the cells unchanged when the paste has no usable characters", () => {
    const current = ["A", "", "", "", "", ""];
    expect(distributePaste("---", 0, current)).toEqual(current);
  });
});

describe("nextFocusIndex", () => {
  it("advances after typing", () => {
    expect(nextFocusIndex(0, "type", true)).toBe(1);
  });

  it("stops at the last cell when typing", () => {
    expect(nextFocusIndex(5, "type", true)).toBe(5);
  });

  it("stays put when erasing a cell that had a character", () => {
    // Backspace on a filled cell clears it and leaves the caret there.
    expect(nextFocusIndex(3, "erase", false)).toBe(3);
  });

  it("moves back when erasing an already-empty cell", () => {
    expect(nextFocusIndex(3, "erase", true)).toBe(2);
  });

  it("stops at the first cell when erasing", () => {
    expect(nextFocusIndex(0, "erase", true)).toBe(0);
  });
});
