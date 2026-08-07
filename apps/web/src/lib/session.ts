import type { LookupResponse } from "@shared/types.ts";

const STORAGE_KEY = "match-result";

/**
 * Results live in sessionStorage only: closing the tab discards them, and
 * nothing survives on a shared device.
 */
export function saveResult(result: LookupResponse): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(result));
  } catch {
    // Private browsing can reject writes. The current render still works.
  }
}

export function loadResult(): LookupResponse | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    return JSON.parse(raw) as LookupResponse;
  } catch {
    return null;
  }
}

export function clearResult(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do.
  }
}
