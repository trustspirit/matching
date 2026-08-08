import type { AdminParticipantRow } from "@shared/types.ts";

/**
 * Filters the in-memory participant list for the match editor's autocomplete.
 * The whole list (~350 rows) is fetched once when the admin screen opens, so
 * filtering here avoids a request per keystroke.
 *
 * Matching is a plain substring test on the display name. The source data has
 * people who share a name, so callers must show the birthdate alongside each
 * suggestion -- the name alone does not identify a participant.
 */
export function searchParticipants(
  all: AdminParticipantRow[],
  gender: "M" | "F",
  query: string,
  limit = 8,
): AdminParticipantRow[] {
  const needle = query.trim();
  return all
    .filter((p) => p.gender === gender)
    .filter((p) => needle === "" || p.displayName.includes(needle))
    .slice(0, limit);
}
