import { CODE_ALPHABET, CODE_LENGTH, normalizeCode } from "@shared/code.ts";

/**
 * Pure helpers for the six-cell code input. They are kept free of DOM access
 * so they can be tested with the repo's existing vitest setup -- adding jsdom
 * and testing-library just for this component would cost more than it returns.
 * The DOM wiring (focus moves, key events) is verified with Playwright.
 */

/** Returns the upper-cased character if the alphabet allows it, else null. */
export function acceptChar(raw: string): string | null {
  if (raw.length !== 1) return null;
  const upper = raw.toUpperCase();
  return CODE_ALPHABET.includes(upper) ? upper : null;
}

/**
 * Spreads a pasted string across the cells starting at `startIndex`.
 * normalizeCode strips anything that is not an ASCII alphanumeric, so a code
 * copied in the older hyphenated form (K7M-2QX) still lands correctly.
 */
export function distributePaste(
  pasted: string,
  startIndex: number,
  current: string[],
): string[] {
  const next = [...current];
  const chars = normalizeCode(pasted);
  for (let i = 0; i < chars.length; i++) {
    const target = startIndex + i;
    if (target >= CODE_LENGTH) break;
    const ch = acceptChar(chars[i]!);
    if (ch !== null) next[target] = ch;
  }
  return next;
}

/**
 * Where the caret belongs after an edit.
 *
 * `cellWasEmpty` is required because Backspace behaves differently depending
 * on the cell's contents: on a filled cell it clears the character and stays,
 * on an empty cell it steps back. The action alone cannot distinguish them.
 */
export function nextFocusIndex(
  current: number,
  action: "type" | "erase",
  cellWasEmpty: boolean,
): number {
  if (action === "type") return Math.min(current + 1, CODE_LENGTH - 1);
  if (!cellWasEmpty) return current;
  return Math.max(current - 1, 0);
}
