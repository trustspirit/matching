/**
 * ALLOWED_ORIGIN is a comma-separated allow-list, e.g.
 * "https://matching.pages.dev,http://localhost:5173".
 */
function allowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGIN") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowed = allowedOrigins();
  // Echo the origin only when it is on the list; never reflect it blindly.
  const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] ?? "");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function handlePreflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function jsonResponse(
  req: Request,
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}
