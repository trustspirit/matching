import { assertEquals } from "jsr:@std/assert@1";
import { sendCodeEmail } from "./sendEmail.ts";

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
