export interface CategoryColor {
  /** Badge background. */
  bg: string;
  /** Badge text, picked so the pair clears WCAG AA (4.5:1). */
  fg: string;
}

/**
 * Categorical badge colours, ordered so that any prefix is as distinguishable
 * as that length allows. The order came from a greedy max-min pass over OKLab
 * distance, then each prefix was checked with the data-viz validator on the
 * all-pairs list (a table shows every badge at once, so adjacent-only is the
 * wrong test).
 *
 * Prefix results, all-pairs, light surface:
 *   4 colours → PASS, worst normal-vision ΔE 20.8
 *   6 colours → PASS, worst normal-vision ΔE 15.6 (floor is 15)
 *   8 colours → FAIL, worst normal-vision ΔE 7.1
 *
 * Six is therefore the honest ceiling. Beyond that a category gets NEUTRAL:
 * a seventh hue would look like one of the first six rather than add meaning.
 * Every badge also prints its label, so colour is a scanning aid and never the
 * only way to tell two categories apart.
 */
const PALETTE: CategoryColor[] = [
  { bg: "#eda100", fg: "#000000" },
  { bg: "#4a3aa7", fg: "#ffffff" },
  { bg: "#008300", fg: "#ffffff" },
  { bg: "#e34948", fg: "#000000" },
  { bg: "#2a78d6", fg: "#000000" },
  { bg: "#1baf7a", fg: "#000000" },
];

/** Used past the palette's end, and for anything without a category. */
export const NEUTRAL: CategoryColor = { bg: "#e5e5e0", fg: "#211922" };

/**
 * Maps a value to a colour by its position in `all`.
 *
 * `offset` shifts where this dimension starts in the palette. Two dimensions
 * shown side by side (session and venue, say) must not both start at slot 0,
 * or "1부" and the first venue come out the same colour and look related when
 * they are not.
 *
 * `all` must be a stable, sorted list of every value that exists -- not the
 * values currently on screen. Deriving it from the filtered rows would repaint
 * the survivors whenever a filter changed, which breaks the reader's mapping
 * between a colour and a thing.
 */
export function categoryColor(
  value: string,
  all: string[],
  offset = 0,
): CategoryColor {
  const index = all.indexOf(value);
  if (index === -1) return NEUTRAL;
  const slot = index + offset;
  if (slot >= PALETTE.length) return NEUTRAL;
  return PALETTE[slot]!;
}

/** Distinct values in a stable order, so colours do not move between renders. */
export function categoryValues(values: (string | null)[]): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    if (v !== null && v !== "") seen.add(v);
  }
  return [...seen].sort();
}
