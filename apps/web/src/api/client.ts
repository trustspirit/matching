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

export async function lookup(name: string, code: string): Promise<LookupResponse> {
  let res: Response;
  try {
    res = await fetch(endpoint("/lookup"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, code }),
    });
  } catch {
    throw new ApiError("network_error");
  }
  if (!res.ok) return await readError(res);
  return await res.json() as LookupResponse;
}

export async function adminImport(
  password: string,
  file: File,
  regenerateCodes: boolean,
): Promise<ImportResponse> {
  const form = new FormData();
  form.append("file", file);
  if (regenerateCodes) form.append("regenerateCodes", "true");

  let res: Response;
  try {
    res = await fetch(endpoint("/admin-import"), {
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
