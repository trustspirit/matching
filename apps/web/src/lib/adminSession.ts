const STORAGE_KEY = "admin-session-token";

/**
 * localStorage rather than sessionStorage: the session has to survive closing
 * the tab, since the requirement is "until logout". The server bounds it at 12
 * hours regardless.
 *
 * This is not HttpOnly and is therefore readable by any script on the page.
 * Making it HttpOnly would need the API to be same-origin with the site; it is
 * not (pages.dev vs supabase.co), and a third-party cookie is blocked outright
 * by Safari. Keeping the credential in a header also means CSRF is impossible,
 * which a cookie with SameSite=None would give up.
 */
export function loadAdminToken(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null || raw === "" ? null : raw;
  } catch {
    return null;
  }
}

export function saveAdminToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Private-mode quota errors are not worth failing the login over; the
    // session simply will not survive a reload.
  }
}

export function clearAdminToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the token was not stored in the first place.
  }
}
