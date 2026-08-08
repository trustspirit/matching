import { describe, expect, it } from "vitest";
import type { AdminParticipantRow } from "@shared/types.ts";
import { searchParticipants } from "./participantSearch";

const people: AdminParticipantRow[] = [
  { id: "1", displayName: "김철수", birthdate: "1999-01-02", gender: "M", contact: null, email: null },
  { id: "2", displayName: "김철수", birthdate: "2001-07-14", gender: "M", contact: null, email: null },
  { id: "3", displayName: "김철민", birthdate: "2000-03-22", gender: "M", contact: null, email: null },
  { id: "4", displayName: "이영희", birthdate: "1999-05-06", gender: "F", contact: null, email: null },
];

describe("searchParticipants", () => {
  it("returns only the requested gender", () => {
    const result = searchParticipants(people, "F", "");
    expect(result.map((p) => p.id)).toEqual(["4"]);
  });

  it("matches on a name prefix", () => {
    const result = searchParticipants(people, "M", "김철");
    expect(result.map((p) => p.id)).toEqual(["1", "2", "3"]);
  });

  it("keeps both people when names collide", () => {
    // Same name, different birthdates. Both must stay so the operator can
    // pick the right one.
    const result = searchParticipants(people, "M", "김철수");
    expect(result.map((p) => p.birthdate)).toEqual(["1999-01-02", "2001-07-14"]);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(searchParticipants(people, "M", "  김철민  ").map((p) => p.id))
      .toEqual(["3"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(searchParticipants(people, "M", "박")).toEqual([]);
  });

  it("caps the number of suggestions", () => {
    expect(searchParticipants(people, "M", "", 2)).toHaveLength(2);
  });
});
