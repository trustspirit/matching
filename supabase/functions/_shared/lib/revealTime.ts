import type { Session } from "./types.ts";

/**
 * Everything here pins the clock to Asia/Seoul rather than reading whatever
 * zone the machine happens to be in. Both ends need that: an Edge Function
 * runs in UTC, and an organiser could open the admin screen from a laptop
 * still set to another country. A session opens at 9:50pm in Seoul, and
 * nowhere else.
 *
 * A fixed +09:00 is exact, not an approximation -- Korea has had no daylight
 * saving since 1988, so there is no ambiguous or skipped wall-clock time to
 * resolve.
 */
export const KST_OFFSET = "+09:00";

/** app_config key holding the instant a session's partner becomes visible. */
export function revealKey(session: Session): string {
  return `reveal_at_${session}`;
}

/**
 * Turns the value of a datetime-local input, which carries no zone at all,
 * into an instant by reading it as Seoul wall-clock time. Returns null for
 * anything that is not a complete "YYYY-MM-DDTHH:mm".
 */
export function kstLocalToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const iso = `${local}:00${KST_OFFSET}`;
  if (Number.isNaN(new Date(iso).getTime())) return null;
  // Date does not reject an impossible day, it rolls it over: 2026-02-31
  // silently becomes March 3rd. Rendering the instant back onto a Seoul clock
  // and requiring it to match is what catches that. A date input cannot
  // produce such a value, but this action is reachable over HTTP too.
  if (isoToKstLocal(iso) !== local) return null;
  return iso;
}

function kstParts(iso: string): Record<string, string> | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const out: Record<string, string> = {};
  for (const part of parts) out[part.type] = part.value;
  return out;
}

/**
 * The inverse: an instant rendered as the wall-clock string a
 * datetime-local input expects, read off a Seoul clock.
 */
export function isoToKstLocal(iso: string): string {
  const p = kstParts(iso);
  if (p === null) return "";
  // hour12:false still emits "24" for midnight in some engines.
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}`;
}

/** "8월 14일 오후 9:50", for telling a participant when to come back. */
export function formatKst(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}
