/**
 * Transactional email through Brevo's HTTP API.
 *
 * HTTP rather than SMTP on purpose: an edge runtime handles a single fetch far
 * more predictably than a raw TCP session, and Brevo lets a single sender
 * address be verified, so no domain is required.
 */

/**
 * Brevo distinguishes causes that call for opposite responses: 402 means the
 * daily allowance is gone and retrying today is pointless, while 429 is a
 * per-second bucket that clears on its own. Collapsing both into "failed" --
 * as this module used to -- makes a quota wall look like 300 bad addresses.
 */
export type SendResult =
  | { kind: "sent" }
  | { kind: "disabled" }
  | { kind: "quota" }
  | { kind: "throttled"; retryAfterSec: number }
  | { kind: "failed"; reason: string };

interface BrevoConfig {
  apiKey: string;
  senderEmail: string;
  senderName: string;
}

/** Returns null when the feature is not configured, which is not an error. */
function readConfig(): BrevoConfig | null {
  const apiKey = Deno.env.get("BREVO_API_KEY") ?? "";
  const senderEmail = Deno.env.get("BREVO_SENDER_EMAIL") ?? "";
  const senderName = Deno.env.get("BREVO_SENDER_NAME") ?? "";
  if (apiKey === "" || senderEmail === "") return null;
  return { apiKey, senderEmail, senderName: senderName || senderEmail };
}

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

/** Overridable so tests can point at a local stub; Brevo otherwise. */
function apiUrl(): string {
  return Deno.env.get("BREVO_API_URL") ?? BREVO_URL;
}

/**
 * RFC 2606 reserves example.com and the .test/.invalid/.example/.localhost
 * TLDs precisely so they can never receive mail. One of these reaching the
 * real Brevo account always means test data met production credentials: it
 * spends one of the day's 300 messages and returns a bounce, which costs
 * sender reputation. Against a stub they are the correct addresses to use, so
 * the guard keys on the endpoint rather than banning them outright.
 */
function isUndeliverableByDesign(address: string): boolean {
  const domain = address.split("@").at(-1)?.toLowerCase() ?? "";
  return /(^|\.)example\.(com|net|org)$/.test(domain) ||
    /\.(test|invalid|example|localhost)$/.test(domain);
}

/**
 * Brevo reports the wait in seconds via x-sib-ratelimit-reset. A missing or
 * unparseable header falls back to a minute, which clears any per-second
 * bucket without the caller having to guess.
 */
function retryAfterSeconds(res: Response): number {
  const parsed = Number.parseInt(
    res.headers.get("x-sib-ratelimit-reset") ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

export function emailEnabled(): boolean {
  return readConfig() !== null;
}

/**
 * Where to send the participant. Reuses ALLOWED_ORIGIN rather than adding
 * another secret: its first entry is already the deployed site, since that is
 * what the CORS allow-list is built from. Returns null when it is unset, and
 * the mail simply omits the link.
 */
function siteUrl(): string | null {
  const first = (Deno.env.get("ALLOWED_ORIGIN") ?? "").split(",")[0]?.trim();
  if (first === undefined || first === "") return null;
  // A localhost entry is a development artefact; linking a participant there
  // would be worse than linking nothing.
  if (first.startsWith("http://localhost") || first.startsWith("http://127.")) {
    return null;
  }
  return first;
}

/**
 * Free text naming who to ask for help, shown at the bottom of the mail.
 *
 * This is what lets the sender be a noreply address: replies would otherwise
 * vanish, and out of a few hundred participants some always reply. Unset means
 * the line is omitted rather than printing an empty prompt.
 */
function eventContact(): string | null {
  const value = (Deno.env.get("EVENT_CONTACT") ?? "").trim();
  return value === "" ? null : value;
}

/** Keeps operator-supplied text from breaking the surrounding markup. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Sends one participant their code.
 *
 * The subject deliberately omits the code: it would otherwise show up in lock
 * screen previews and notification banners, and the code is the participant's
 * only credential.
 */
export async function sendCodeEmail(
  to: string,
  displayName: string,
  code: string,
): Promise<SendResult> {
  const config = readConfig();
  if (config === null) return { kind: "disabled" };
  const endpoint = apiUrl();
  if (endpoint === BREVO_URL && isUndeliverableByDesign(to)) {
    console.error("refusing to spend quota on a reserved test address", to);
    return { kind: "failed", reason: "reserved test domain" };
  }
  const site = siteUrl();
  const contact = eventContact();

  const body = {
    sender: { email: config.senderEmail, name: config.senderName },
    to: [{ email: to, name: displayName }],
    subject: "매칭 결과 확인 코드 안내",
    htmlContent: [
      `<p>${escapeHtml(displayName)}님, 안녕하세요.</p>`,
      "<p>매칭 결과를 확인하실 코드입니다.</p>",
      `<p style="font-size:24px;font-weight:bold;letter-spacing:2px">${code}</p>`,
      site === null
        ? "<p>안내받으신 사이트에서 이 코드를 입력하시면 상대방과 시간, 장소를 보실 수 있습니다.</p>"
        : `<p>아래 주소에서 코드를 입력하시면 상대방과 시간, 장소를 보실 수 있습니다.</p><p><a href="${site}">${site}</a></p>`,
      "<p>이 코드는 본인 확인에 쓰이니 다른 분과 공유하지 말아주세요.</p>",
      ...(contact === null ? [] : [
        // The sender is a noreply address, so the mail has to say where a
        // question actually goes.
        `<p style="color:#62625b">이 메일은 회신을 받지 않습니다. 문의는 ${escapeHtml(contact)} 로 연락해주세요.</p>`,
      ]),
    ].join(""),
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "api-key": config.apiKey,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (caught) {
    console.error("brevo request failed", caught);
    return { kind: "failed", reason: "network" };
  }

  if (res.status === 402) {
    await res.body?.cancel();
    return { kind: "quota" };
  }
  if (res.status === 429) {
    const retryAfterSec = retryAfterSeconds(res);
    await res.body?.cancel();
    return { kind: "throttled", retryAfterSec };
  }
  if (!res.ok) {
    // Brevo puts the reason in the body; without it a rejected key and a
    // rejected recipient look identical. This string is shown to the admin,
    // so it is truncated rather than logged and discarded.
    const body = await res.text();
    console.error("brevo rejected the message", res.status, body);
    return { kind: "failed", reason: `${res.status} ${body.slice(0, 200)}` };
  }
  await res.body?.cancel();
  return { kind: "sent" };
}

const BREVO_ACCOUNT_URL = "https://api.brevo.com/v3/account";

function accountUrl(): string {
  return Deno.env.get("BREVO_ACCOUNT_URL") ?? BREVO_ACCOUNT_URL;
}

export interface QuotaInfo {
  /** Messages left in today's allowance. */
  credits: number;
  /**
   * IANA zone whose midnight resets that allowance. Brevo counts the day on
   * the account's own clock, not UTC and not ours, and reports it here -- so
   * the reset time is knowable rather than something to probe for.
   */
  timezone: string;
}

/**
 * Asks Brevo how many messages today still allows.
 *
 * Without this the only way to discover the daily wall is to send and take a
 * 402, which costs a freshly minted code that then has to be thrown away. The
 * free plan reports the remaining count as a `sendLimit` credit line.
 *
 * Returns null when the account cannot be read; the caller must then fall back
 * to sending and treating 402 as the signal.
 */
export async function fetchQuota(): Promise<QuotaInfo | null> {
  const config = readConfig();
  if (config === null) return null;

  let res: Response;
  try {
    res = await fetch(accountUrl(), {
      headers: { "api-key": config.apiKey, accept: "application/json" },
    });
  } catch (caught) {
    console.error("brevo account request failed", caught);
    return null;
  }
  if (!res.ok) {
    console.error("brevo account rejected", res.status, await res.text());
    return null;
  }

  let body: {
    plan?: { creditsType?: string; credits?: number }[];
    dateTimePreferences?: { timezone?: string };
  };
  try {
    body = await res.json();
  } catch (caught) {
    console.error("brevo account body was not json", caught);
    return null;
  }

  const line = (body.plan ?? []).find((p) => p.creditsType === "sendLimit");
  if (line === undefined || typeof line.credits !== "number") return null;

  return {
    credits: line.credits,
    // UTC is the safe fallback: guessing a local zone could schedule the retry
    // before the reset, and a too-early retry only costs one wasted probe.
    timezone: body.dateTimePreferences?.timezone ?? "UTC",
  };
}

/** Milliseconds to ADD to a UTC instant to read wall-clock time in `zone`. */
function zoneOffsetMs(zone: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    // Intl can render midnight as hour 24 in some locales/zones.
    parts.hour === 24 ? 0 : parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - at.getTime();
}

/**
 * The next midnight in `zone`, plus five minutes of slack so a clock skew
 * cannot land the retry a moment before the counter actually rolls over.
 *
 * An unknown zone name would make Intl throw and take the whole run with it,
 * so the failure falls back to 24 hours rather than propagating.
 */
export function nextResetAt(zone: string, now: Date): Date {
  const MARGIN_MS = 5 * 60_000;
  try {
    const offset = zoneOffsetMs(zone, now);
    const local = new Date(now.getTime() + offset);
    const nextLocalMidnight = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + 1,
    );
    return new Date(nextLocalMidnight - offset + MARGIN_MS);
  } catch (caught) {
    console.error("unusable timezone from brevo", zone, caught);
    return new Date(now.getTime() + 24 * 3600_000);
  }
}
