import { assertEquals } from "jsr:@std/assert@1";
import {
  fetchQuota,
  nextResetAt,
  sendCodeEmail,
  senderIsValidated,
} from "./sendEmail.ts";

/**
 * Brevo is replaced by a local server. The env override exists only for this:
 * the classification logic is the whole point of this module and it cannot be
 * exercised against the real API.
 */
async function withStub(
  handler: (req: Request) => Response,
  run: () => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    handler,
  );
  const port = (server.addr as Deno.NetAddr).port;
  Deno.env.set("BREVO_API_URL", `http://127.0.0.1:${port}/`);
  Deno.env.set("BREVO_API_KEY", "test-key");
  Deno.env.set("BREVO_SENDER_EMAIL", "noreply@example.com");
  try {
    await run();
  } finally {
    controller.abort();
    await server.finished;
  }
}

Deno.test("a 2xx response is a send", async () => {
  await withStub(
    () => new Response(JSON.stringify({ messageId: "1" }), { status: 201 }),
    async () => {
      assertEquals(await sendCodeEmail("a@example.com", "가", "ABC123"), {
        kind: "sent",
      });
    },
  );
});

Deno.test("402 is the daily quota, not a transient failure", async () => {
  await withStub(
    () => new Response(JSON.stringify({ code: "not_enough_credits" }), { status: 402 }),
    async () => {
      assertEquals(await sendCodeEmail("a@example.com", "가", "ABC123"), {
        kind: "quota",
      });
    },
  );
});

Deno.test("429 carries the reset delay Brevo asks for", async () => {
  await withStub(
    () =>
      new Response("{}", {
        status: 429,
        headers: { "x-sib-ratelimit-reset": "17" },
      }),
    async () => {
      assertEquals(await sendCodeEmail("a@example.com", "가", "ABC123"), {
        kind: "throttled",
        retryAfterSec: 17,
      });
    },
  );
});

Deno.test("429 without a usable header falls back to a minute", async () => {
  await withStub(
    () => new Response("{}", { status: 429 }),
    async () => {
      assertEquals(await sendCodeEmail("a@example.com", "가", "ABC123"), {
        kind: "throttled",
        retryAfterSec: 60,
      });
    },
  );
});

Deno.test("a rejected recipient fails only that message", async () => {
  await withStub(
    () => new Response(JSON.stringify({ message: "invalid email" }), { status: 400 }),
    async () => {
      const result = await sendCodeEmail("nope", "가", "ABC123");
      assertEquals(result.kind, "failed");
    },
  );
});

Deno.test("an unset API key reports disabled rather than failing", async () => {
  Deno.env.delete("BREVO_API_KEY");
  Deno.env.delete("BREVO_API_URL");
  assertEquals(await sendCodeEmail("a@example.com", "가", "ABC123"), {
    kind: "disabled",
  });
});

Deno.test("the real endpoint refuses an address reserved for testing", async () => {
  // supabase/functions/.env holds the production Brevo key, so a test address
  // reaching the real endpoint is one wasted message from a 300/day allowance
  // plus a bounce. Against a stub the same address is exactly right, so the
  // guard keys on the endpoint, not the address alone.
  Deno.env.set("BREVO_API_KEY", "test-key");
  Deno.env.set("BREVO_SENDER_EMAIL", "noreply@example.com");
  Deno.env.delete("BREVO_API_URL");

  for (const address of ["p0@example.com", "x@foo.test", "y@bar.invalid"]) {
    const result = await sendCodeEmail(address, "가", "ABC123");
    assertEquals(result.kind, "failed", address);
  }
});

/** Points BREVO_SENDERS_URL at the stub and answers with `senders`. */
async function withSenders(
  senders: unknown,
  run: () => Promise<void>,
): Promise<void> {
  await withStub(
    () => new Response(JSON.stringify({ senders }), { status: 200 }),
    async () => {
      Deno.env.set("BREVO_SENDERS_URL", Deno.env.get("BREVO_API_URL")!);
      await run();
    },
  );
}

Deno.test("senderIsValidated accepts the configured address", async () => {
  await withSenders(
    [{ id: 1, email: "noreply@example.com", active: true }],
    async () => assertEquals(await senderIsValidated(), true),
  );
});

Deno.test("senderIsValidated ignores casing", async () => {
  await withSenders(
    [{ id: 1, email: "NoReply@Example.com", active: true }],
    async () => assertEquals(await senderIsValidated(), true),
  );
});

Deno.test("senderIsValidated rejects a plus-address of a validated sender", async () => {
  // Brevo treats these as separate senders, which is exactly how a working
  // account came to reject 286 messages in a row.
  await withSenders(
    [{ id: 1, email: "someone@example.com", active: true }],
    async () => {
      Deno.env.set("BREVO_SENDER_EMAIL", "someone+noreply@example.com");
      assertEquals(await senderIsValidated(), false);
    },
  );
});

Deno.test("senderIsValidated rejects a sender Brevo lists as inactive", async () => {
  await withSenders(
    [{ id: 1, email: "noreply@example.com", active: false }],
    async () => assertEquals(await senderIsValidated(), false),
  );
});

Deno.test("senderIsValidated returns null when the answer is unknown", async () => {
  // Callers must not block sending on this: refusing to mail because a status
  // call failed would be worse than the problem it guards against.
  await withStub(
    () => new Response("nope", { status: 500 }),
    async () => {
      Deno.env.set("BREVO_SENDERS_URL", Deno.env.get("BREVO_API_URL")!);
      assertEquals(await senderIsValidated(), null);
    },
  );
});

Deno.test("fetchQuota reads the sendLimit line and the account timezone", async () => {
  await withStub(
    () =>
      new Response(
        JSON.stringify({
          plan: [
            { type: "free", credits: 42, creditsType: "sendLimit" },
            { type: "free", credits: 9, creditsType: "somethingElse" },
          ],
          dateTimePreferences: { timezone: "Asia/Seoul" },
        }),
        { status: 200 },
      ),
    async () => {
      Deno.env.set("BREVO_ACCOUNT_URL", Deno.env.get("BREVO_API_URL")!);
      assertEquals(await fetchQuota(), { credits: 42, timezone: "Asia/Seoul" });
    },
  );
});

Deno.test("fetchQuota falls back to UTC when the account omits a timezone", async () => {
  await withStub(
    () =>
      new Response(
        JSON.stringify({ plan: [{ credits: 0, creditsType: "sendLimit" }] }),
        { status: 200 },
      ),
    async () => {
      Deno.env.set("BREVO_ACCOUNT_URL", Deno.env.get("BREVO_API_URL")!);
      assertEquals(await fetchQuota(), { credits: 0, timezone: "UTC" });
    },
  );
});

Deno.test("fetchQuota returns null rather than guessing when the account is unreadable", async () => {
  await withStub(
    () => new Response("nope", { status: 500 }),
    async () => {
      Deno.env.set("BREVO_ACCOUNT_URL", Deno.env.get("BREVO_API_URL")!);
      assertEquals(await fetchQuota(), null);
    },
  );
});

Deno.test("nextResetAt targets the next midnight in the account's zone", () => {
  // 2026-08-09T10:00:00Z is 19:00 the same day in Seoul (UTC+9), so the next
  // Seoul midnight is 2026-08-10T00:00 KST == 2026-08-09T15:00Z, plus 5 min.
  const at = nextResetAt("Asia/Seoul", new Date("2026-08-09T10:00:00Z"));
  assertEquals(at.toISOString(), "2026-08-09T15:05:00.000Z");
});

Deno.test("nextResetAt handles an instant already past the local midnight", () => {
  // 2026-08-09T16:00:00Z is 01:00 on the 10th in Seoul, so the next midnight
  // is the 11th at 00:00 KST == 2026-08-10T15:00Z.
  const at = nextResetAt("Asia/Seoul", new Date("2026-08-09T16:00:00Z"));
  assertEquals(at.toISOString(), "2026-08-10T15:05:00.000Z");
});

Deno.test("nextResetAt falls back to a day rather than throwing on a bad zone", () => {
  const now = new Date("2026-08-09T10:00:00Z");
  assertEquals(
    nextResetAt("Not/AZone", now).toISOString(),
    "2026-08-10T10:00:00.000Z",
  );
});
