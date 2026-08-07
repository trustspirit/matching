import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import { hashCode, randomSalt, timingSafeEqual } from "../_shared/hash.ts";
import { generateCode } from "../_shared/lib/code.ts";
import { buildCodesCsv, parseMatchCsv } from "../_shared/lib/csv.ts";
import type { CodeRow, ParsedPerson } from "../_shared/lib/types.ts";

/** Identity key for a participant, matching the DB's unique constraint. */
function personKey(person: ParsedPerson): string {
  return `${person.name}|${person.birthdate}`;
}

function isAuthorized(req: Request): boolean {
  const expected = Deno.env.get("ADMIN_PASSWORD") ?? "";
  const header = req.headers.get("Authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (expected === "" || provided === "") return false;
  return timingSafeEqual(provided, expected);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return handlePreflight(req);
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "invalid_request" }, 405);
  }
  if (!isAuthorized(req)) {
    return jsonResponse(req, { error: "unauthorized" }, 401);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse(req, { error: "invalid_request" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonResponse(req, { error: "invalid_request", errors: ["파일이 없습니다."] }, 400);
  }
  const regenerateCodes = form.get("regenerateCodes") === "true";

  const parsed = parseMatchCsv(await file.text());
  if (parsed.errors.length > 0) {
    // Nothing is written when parsing fails: the import is all-or-nothing.
    return jsonResponse(req, { error: "invalid_csv", errors: parsed.errors }, 400);
  }

  // Deduplicate people across rows. A woman attending twice appears in two
  // rows but is one participant.
  const people = new Map<string, ParsedPerson>();
  for (const match of parsed.matches) {
    people.set(personKey(match.male), match.male);
    people.set(personKey(match.female), match.female);
  }

  const db = createServiceClient();

  const { data: existingRows, error: existingError } = await db
    .from("participants")
    .select("name, birthdate")
    .returns<{ name: string; birthdate: string }[]>();
  if (existingError) {
    return jsonResponse(req, { error: "server_error" }, 500);
  }
  const existing = new Set(
    (existingRows ?? []).map((row) => `${row.name}|${row.birthdate}`),
  );

  const participantPayload: Record<string, unknown>[] = [];
  const codeRows: CodeRow[] = [];
  let created = 0;
  let updated = 0;

  for (const person of people.values()) {
    const isNew = !existing.has(personKey(person));
    if (isNew) created++;
    else updated++;

    const needsCode = isNew || regenerateCodes;
    let code: string | null = null;
    let salt = "";
    let hash = "";

    if (needsCode) {
      code = generateCode();
      salt = randomSalt();
      hash = await hashCode(salt, code);
    }

    participantPayload.push({
      name: person.name,
      display_name: person.displayName,
      birthdate: person.birthdate,
      gender: person.gender,
      contact: person.contact ?? "",
      email: person.email ?? "",
      // Empty strings tell import_matches to keep the stored values.
      code_salt: salt,
      code_hash: hash,
    });

    codeRows.push({
      displayName: person.displayName,
      gender: person.gender,
      contact: person.contact,
      email: person.email,
      code,
    });
  }

  const matchPayload = parsed.matches.map((match) => ({
    session: match.session,
    time_range: match.timeRange,
    arrive_by: match.arriveBy,
    venue: match.venue,
    team: match.team ?? "",
    male_name: match.male.name,
    male_birthdate: match.male.birthdate,
    female_name: match.female.name,
    female_birthdate: match.female.birthdate,
  }));

  const { error: importError } = await db.rpc("import_matches", {
    payload: { participants: participantPayload, matches: matchPayload },
  });
  if (importError) {
    return jsonResponse(
      req,
      { error: "server_error", errors: [importError.message] },
      500,
    );
  }

  return jsonResponse(req, {
    participants: { created, updated },
    matches: parsed.matches.length,
    warnings: parsed.warnings,
    codesCsv: buildCodesCsv(codeRows),
  });
});
