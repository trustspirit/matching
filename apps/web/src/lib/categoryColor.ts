export interface CategoryColor {
  /** Badge background. */
  bg: string;
  /** Badge text, picked so the pair clears 7:1 -- see PALETTE. */
  fg: string;
}

/**
 * Categorical badge colours. Every entry clears 7:1 against its own text --
 * not the WCAG AA 4.5:1 floor, which at this label size left black type
 * sitting in the background colour instead of on top of it.
 *
 * Found by sweeping the whole hue circle in OKLCh: for each hue, the most
 * saturated in-gamut colour that still clears 7:1 against black or white,
 * then a greedy max-min pass over the set. Two constraints were added after
 * the first passes returned nonsense -- a chroma cap, because unbounded
 * chroma gave neon; and a 40-degree minimum hue gap, because pure max-min
 * happily returns four blues separated only by lightness.
 *
 * Checked with the data-viz validator on the all-pairs list -- a table shows
 * every badge at once, so adjacent-only is the wrong test:
 *   normal vision  worst ΔE 16.5   (floor 15)  PASS
 *   colour blind   worst ΔE 10.1   (floor 8)   PASS
 *
 * The validator's lightness-band check fails by design and is not a defect
 * here: it assumes a chart mark with its text beside it, so it wants
 * mid-lightness fills. Our text sits ON the fill, and 7:1 forces each colour
 * to one end of the lightness range or the other.
 *
 * Six is the ceiling, and it is a hard one -- seven drops the worst pair to
 * 10.5 and eight to 8.9, both below what normal vision resolves. Beyond six a
 * category gets NEUTRAL rather than a seventh hue that would read as a
 * duplicate of one of these. Every badge also prints its label, so colour is
 * a scanning aid and never the only way to tell two categories apart.
 */
const PALETTE: CategoryColor[] = [
  { bg: "#81023d", fg: "#ffffff" },
  { bg: "#dd8207", fg: "#000000" },
  { bg: "#02b474", fg: "#000000" },
  { bg: "#03d0f3", fg: "#000000" },
  { bg: "#0048a0", fg: "#ffffff" },
  { bg: "#3d036e", fg: "#ffffff" },
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
