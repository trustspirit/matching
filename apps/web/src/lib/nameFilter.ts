/**
 * Substring name search for the admin tables.
 *
 * Deliberately separate from `normalizeName` in the shared lib: that one also
 * applies the alias table, which is right for identifying a participant and
 * wrong for a search box. Typing an alias's key should not silently jump to a
 * different name than the one on screen.
 *
 * Whitespace is dropped on both sides so "김 철수" finds "김철수", NFC keeps
 * decomposed Hangul from a paste comparing unequal to the composed form in the
 * table, and lower-casing covers the Latin names in the source data.
 */
function normalize(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, "").toLowerCase();
}

/**
 * True when any of `names` contains `query`. An empty or whitespace-only query
 * matches everything, so the caller can pass the raw input box value straight
 * through without special-casing the cleared state.
 */
export function nameMatches(
  query: string,
  ...names: (string | null | undefined)[]
): boolean {
  const needle = normalize(query);
  if (needle === "") return true;
  return names.some((name) =>
    name !== null && name !== undefined && normalize(name).includes(needle)
  );
}
