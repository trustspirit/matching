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

  const body = {
    sender: { email: config.senderEmail, name: config.senderName },
    to: [{ email: to, name: displayName }],
    subject: "매칭 결과 확인 코드 안내",
    htmlContent: [
      `<p>${displayName}님, 안녕하세요.</p>`,
      "<p>매칭 결과를 확인하실 코드입니다.</p>",
      `<p style="font-size:24px;font-weight:bold;letter-spacing:2px">${code}</p>`,
      "<p>사이트에서 이 코드를 입력하시면 상대방과 시간, 장소를 보실 수 있습니다.</p>",
      "<p>이 코드는 본인 확인에 쓰이니 다른 분과 공유하지 말아주세요.</p>",
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
