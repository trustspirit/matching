import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import {
  ADMIN_POLICY,
  clientIp,
  getIpSalt,
  hashIp,
  isRateLimited,
} from "../_shared/rateLimit.ts";
import { bearerToken, verifySession } from "../_shared/session.ts";
import { mintUniqueCode, type TakenCode } from "../_shared/mintCode.ts";
import { buildCodesCsv, parseMatchCsv } from "../_shared/lib/csv.ts";
import type { CodeRow, ParsedPerson } from "../_shared/lib/types.ts";

/** Identity key for a participant, matching the DB's unique constraint. */
function personKey(person: ParsedPerson): string {
  return `${person.name}|${person.birthdate}`;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return handlePreflight(req);
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "invalid_request" }, 405);
  }
  const db = createServiceClient();

  const salt = await getIpSalt(db);
  const ipHash = salt === null ? null : await hashIp(clientIp(req), salt);

  if (ipHash !== null && await isRateLimited(db, ipHash, ADMIN_POLICY)) {
    return jsonResponse(
      req,
      { error: "too_many_attempts", retryAfter: 900 },
      429,
    );
  }

  // The password never reaches this function any more: admin-data's `login`
  // exchanges it for a token, and failed password guesses are counted there.
  // The rate limit check above stays so a locked-out admin cannot upload
  // either.
  if (!await verifySession(db, bearerToken(req))) {
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

  // The salt/hash pairs come along so newly minted codes can be checked
  // against every code already in use: a code alone identifies a participant
  // now, so two people must never share one.
  const { data: existingRows, error: existingError } = await db
    .from("participants")
    .select("name, birthdate, code_salt, code_hash")
    .returns<
      { name: string; birthdate: string; code_salt: string; code_hash: string }[]
    >();
  if (existingError) {
    return jsonResponse(req, { error: "server_error" }, 500);
  }
  const existing = new Set(
    (existingRows ?? []).map((row) => `${row.name}|${row.birthdate}`),
  );
  const taken: TakenCode[] = (existingRows ?? []).map((row) => ({
    salt: row.code_salt,
    hash: row.code_hash,
  }));

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
      const minted = await mintUniqueCode(taken);
      code = minted.code;
      salt = minted.salt;
      hash = minted.hash;
      // Guard the rest of this batch against colliding with what was just
      // minted, not only against what was already stored.
      taken.push({ salt: minted.salt, hash: minted.hash });
    }

    participantPayload.push({
      name: person.name,
      display_name: person.displayName,
      birthdate: person.birthdate,
      gender: person.gender,
      contact: person.contact ?? "",
      email: person.email ?? "",
      // Empty means "not assigned yet"; import_matches turns it back into NULL.
      team: person.team ?? "",
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
