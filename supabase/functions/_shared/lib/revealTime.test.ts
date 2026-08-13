import { describe, expect, it } from "vitest";
import {
  formatKst,
  isoToKstLocal,
  kstLocalToIso,
  revealKey,
} from "./revealTime.ts";

describe("revealKey", () => {
  it("names one config row per session", () => {
    expect(revealKey("1부")).toBe("reveal_at_1부");
    expect(revealKey("2부")).toBe("reveal_at_2부");
  });
});

describe("kstLocalToIso", () => {
  it("reads a zoneless input as Seoul wall-clock time", () => {
    expect(kstLocalToIso("2026-08-14T21:50")).toBe("2026-08-14T21:50:00+09:00");
  });

  it("resolves to the intended instant regardless of where it is read", () => {
    // 21:50 in Seoul is 12:50 UTC. This is the assertion the whole module
    // exists for: the same string must not mean 21:50 in the server's zone.
    const iso = kstLocalToIso("2026-08-14T21:50")!;
    expect(new Date(iso).toISOString()).toBe("2026-08-14T12:50:00.000Z");
  });

  it("rejects an incomplete or malformed value", () => {
    expect(kstLocalToIso("")).toBeNull();
    expect(kstLocalToIso("2026-08-14")).toBeNull();
    expect(kstLocalToIso("2026-08-14 21:50")).toBeNull();
    expect(kstLocalToIso("14/08/2026T21:50")).toBeNull();
  });

  it("rejects a well-shaped date that does not exist", () => {
    expect(kstLocalToIso("2026-02-31T10:00")).toBeNull();
  });
});

describe("isoToKstLocal", () => {
  it("renders an instant as the Seoul clock reads it", () => {
    expect(isoToKstLocal("2026-08-14T12:50:00.000Z")).toBe("2026-08-14T21:50");
  });

  it("rolls the date over when Seoul is already on the next day", () => {
    // 16:00 UTC is 1am the following morning in Seoul; a UTC-based conversion
    // would put the organiser's input on the wrong day.
    expect(isoToKstLocal("2026-08-14T16:00:00.000Z")).toBe("2026-08-15T01:00");
  });

  it("round-trips with kstLocalToIso", () => {
    for (const local of ["2026-08-14T21:50", "2026-01-01T00:00", "2026-12-31T23:59"]) {
      expect(isoToKstLocal(kstLocalToIso(local)!)).toBe(local);
    }
  });

  it("returns an empty string rather than throwing on junk", () => {
    expect(isoToKstLocal("not a date")).toBe("");
  });
});

describe("formatKst", () => {
  it("names the moment in Korean, on the Seoul clock", () => {
    expect(formatKst("2026-08-14T12:50:00.000Z")).toContain("8월 14일");
    expect(formatKst("2026-08-14T12:50:00.000Z")).toContain("9:50");
  });

  it("returns an empty string rather than throwing on junk", () => {
    expect(formatKst("nope")).toBe("");
  });
});
