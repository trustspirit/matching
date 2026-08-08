import type { LookupResponse } from "@shared/types.ts";

const BASE_URL = import.meta.env.VITE_API_URL as string | undefined;

export interface ImportResponse {
  participants: { created: number; updated: number };
  matches: number;
  warnings: string[];
  codesCsv: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfter?: number,
    readonly details?: string[],
  ) {
    super(code);
    this.name = "ApiError";
  }
}

function endpoint(path: string): string {
  if (!BASE_URL) throw new ApiError("missing_api_url");
  return `${BASE_URL}${path}`;
}

async function readError(res: Response): Promise<never> {
  let code = "server_error";
  let retryAfter: number | undefined;
  let details: string[] | undefined;
  try {
    const body = await res.json();
    if (typeof body.error === "string") code = body.error;
    if (typeof body.retryAfter === "number") retryAfter = body.retryAfter;
    if (Array.isArray(body.errors)) details = body.errors;
  } catch {
    // Body was not JSON; the default code already covers it.
  }
  throw new ApiError(code, retryAfter, details);
}

export async function lookup(code: string): Promise<LookupResponse> {
  // Resolved outside the try: a missing VITE_API_URL must surface as
  // "missing_api_url", not get swallowed by the network-failure catch below.
  const url = endpoint("/lookup");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    throw new ApiError("network_error");
  }
  if (!res.ok) return await readError(res);
  return await res.json() as LookupResponse;
}

/**
 * Exchanges the admin password for a session token. This is the only request
 * that ever carries the password.
 */
export async function adminLogin(password: string): Promise<string> {
  // Resolved outside the try: same reasoning as lookup() above.
  const url = endpoint("/admin-data");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${password}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "login" }),
    });
  } catch {
    throw new ApiError("network_error");
  }
  if (!res.ok) await readError(res);
  return (await res.json() as { token: string }).token;
}

export async function adminLogout(token: string): Promise<void> {
  const url = endpoint("/admin-data");
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "logout" }),
    });
  } catch {
    // The local token is cleared regardless; a failed revoke only means the
    // row lingers until it expires.
  }
}

/**
 * Calls the row-level admin API. The password is re-sent with every request:
 * there is no session, the same as adminVerify and adminImport.
 */
export async function adminData<T>(
  password: string,
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  // Resolved outside the try: same reasoning as lookup() above.
  const url = endpoint("/admin-data");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${password}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, ...params }),
    });
  } catch {
    throw new ApiError("network_error");
  }
  if (!res.ok) await readError(res);
  return await res.json() as T;
}

export async function adminImport(
  password: string,
  file: File,
  regenerateCodes: boolean,
): Promise<ImportResponse> {
  const form = new FormData();
  form.append("file", file);
  if (regenerateCodes) form.append("regenerateCodes", "true");

  // Resolved outside the try: same reasoning as lookup() above.
  const url = endpoint("/admin-import");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${password}` },
      body: form,
    });
  } catch {
    throw new ApiError("network_error");
  }
  if (!res.ok) return await readError(res);
  return await res.json() as ImportResponse;
}
