/**
 * Salt used to burn an equivalent amount of CPU when no participant matched,
 * so response time does not reveal whether the name exists.
 */
export const DUMMY_SALT = "00000000000000000000000000000000";

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 16 random bytes rendered as 32 hex characters. */
export function randomSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function hashHex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return toHex(new Uint8Array(digest));
}

/** Must receive an already-normalized code, never raw user input. */
export function hashCode(salt: string, normalizedCode: string): Promise<string> {
  return hashHex(salt + normalizedCode);
}

/**
 * Compares two hex digests without short-circuiting on the first mismatch.
 * Length is not secret here: both operands are fixed-width SHA-256 digests.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
