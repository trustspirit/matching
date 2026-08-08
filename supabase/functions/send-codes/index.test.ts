import { assert, assertEquals } from "jsr:@std/assert@1";

const BASE = Deno.env.get("FUNCTIONS_URL") ?? "http://127.0.0.1:54321/functions/v1";
const PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "local-admin";

let sessionToken = "";

async function token(): Promise<string> {
  if (sessionToken !== "") return sessionToken;
  const res = await fetch(`${BASE}/admin-data`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PASSWORD}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "login" }),
  });
  assertEquals(res.status, 200);
  sessionToken = (await res.json()).token;
  return sessionToken;
}

async function call(
  action: string,
  options: { auth?: string; cronSecret?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.cronSecret !== undefined) {
    headers["x-cron-secret"] = options.cronSecret;
  } else {
    headers.Authorization = `Bearer ${options.auth ?? await token()}`;
  }
  return await fetch(`${BASE}/send-codes`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action }),
  });
}

Deno.test("an unauthenticated call is refused", async () => {
  const res = await call("status", { auth: "not-a-token" });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("status reports the arm flag and the pending count", async () => {
  const res = await call("status");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.armed, false);
  assert(typeof body.pending === "number");
  assert(typeof body.needsAttention === "number");
});

Deno.test("arm and disarm round-trip", async () => {
  const armed = await call("arm");
  assertEquals((await armed.json()).armed, true);

  const after = await call("status");
  assertEquals((await after.json()).armed, true);

  const disarmed = await call("disarm");
  assertEquals((await disarmed.json()).armed, false);
});

Deno.test("a run does nothing while disarmed", async () => {
  await (await call("disarm")).body?.cancel();
  const res = await call("run");
  assertEquals(res.status, 200);
  assertEquals((await res.json()).outcome, "disarmed");
});
