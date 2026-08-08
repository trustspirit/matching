import { hashCode, randomSalt } from "./hash.ts";
import { generateCode } from "./lib/code.ts";

/** A code already in use, as stored: per-row salt plus the resulting digest. */
export interface TakenCode {
  salt: string;
  hash: string;
}

export interface MintedCode {
  code: string;
  salt: string;
  hash: string;
}

/**
 * Codes must be unique now that a code alone identifies a participant. Two
 * people sharing one would let each read the other's match.
 *
 * Uniqueness cannot be enforced with a unique index: every row has its own
 * salt, so the same plaintext produces a different digest per row. The only
 * way to test a candidate is to hash it against every stored salt.
 *
 * With 350 participants a full import costs ~122k SHA-256 operations, well
 * under a second. Callers push each result into `taken` before minting the
 * next so a batch cannot collide with itself.
 */
export async function mintUniqueCode(taken: TakenCode[]): Promise<MintedCode> {
  // The alphabet gives 30^6 ≈ 7.29e8 codes, so with a few hundred taken the
  // first candidate is essentially always free; the loop is a guarantee, not a
  // hot path.
  for (;;) {
    const code = generateCode();
    let clash = false;
    for (const entry of taken) {
      if (await hashCode(entry.salt, code) === entry.hash) {
        clash = true;
        break;
      }
    }
    if (clash) continue;

    const salt = randomSalt();
    return { code, salt, hash: await hashCode(salt, code) };
  }
}
