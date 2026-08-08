/** Alphabet with 0/1/I/L/O/U removed so codes survive being copied by hand. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 6;

/**
 * Draws a uniformly distributed integer in [0, max) from the CSPRNG.
 * Uses rejection sampling: taking `byte % max` directly would bias the
 * first (256 % max) values.
 */
function secureRandomInt(max: number): number {
  const limit = Math.floor(256 / max) * max;
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const value = buf[0]!;
    if (value < limit) return value % max;
  }
}

/** `randomInt` is injectable so tests can produce deterministic codes. */
export function generateCode(
  randomInt: (max: number) => number = secureRandomInt,
): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length) % CODE_ALPHABET.length];
  }
  return out;
}

/** Strips anything that is not an ASCII alphanumeric and upper-cases the rest. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function isValidCode(input: string): boolean {
  const code = normalizeCode(input);
  if (code.length !== CODE_LENGTH) return false;
  return [...code].every((ch) => CODE_ALPHABET.includes(ch));
}
