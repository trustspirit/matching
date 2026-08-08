/**
 * Transactional email through Brevo's HTTP API.
 *
 * HTTP rather than SMTP on purpose: an edge runtime handles a single fetch far
 * more predictably than a raw TCP session, and Brevo lets a single sender
 * address be verified, so no domain is required.
 */

export type SendResult = "sent" | "disabled" | "failed";

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
  if (config === null) return "disabled";
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
    res = await fetch("https://api.brevo.com/v3/smtp/email", {
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
    return "failed";
  }

  if (!res.ok) {
    // Brevo puts the reason in the body; without it a rejected key and a
    // rejected recipient look identical in the logs.
    console.error("brevo rejected the message", res.status, await res.text());
    return "failed";
  }
  await res.body?.cancel();
  return "sent";
}
