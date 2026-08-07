/**
 * Maps a normalized name to its canonical form.
 *
 * Keys MUST already be normalized (NFC, whitespace stripped, lower-cased),
 * otherwise the lookup silently never matches.
 *
 * "이승호- lee Seung ho" and "이승호" are the same participant: identical
 * birthdate, phone and email in the source data. Left unmerged they become
 * two people and the man ends up with two matches, which breaks the
 * "men attend at most once" rule.
 */
export const NAME_ALIASES: Record<string, string> = {
  "이승호-leeseungho": "이승호",
};

/** Produces the stable key used for participant lookup. */
export function normalizeName(input: string): string {
  const base = input.normalize("NFC").replace(/\s+/g, "").toLowerCase();
  return NAME_ALIASES[base] ?? base;
}
