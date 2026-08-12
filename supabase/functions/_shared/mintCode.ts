import { generateCode } from "./lib/code.ts";

/**
 * Draws a code no participant already holds, and records it in `taken` so the
 * next call in the same batch cannot repeat it.
 *
 * Uniqueness matters because a code alone identifies a participant: two people
 * sharing one would let each read the other's match. The database enforces
 * that with a unique index; this check exists so a batch import does not have
 * to discover a collision through a failed write.
 *
 * The alphabet gives 30^6 ≈ 7.29e8 codes, so with a few hundred taken the
 * first candidate is essentially always free -- the loop is a guarantee, not a
 * hot path.
 */
export function mintUniqueCode(taken: Set<string>): string {
  for (;;) {
    const code = generateCode();
    if (taken.has(code)) continue;
    taken.add(code);
    return code;
  }
}
