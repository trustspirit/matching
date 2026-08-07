import { formatCode } from "./code.ts";
import { normalizeName } from "./name.ts";
import {
  type CodeRow,
  type ParsedMatch,
  type ParsedPerson,
  type ParseResult,
  type Session,
  SESSION_TIME,
} from "./types.ts";

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // Skip rows that are entirely empty, e.g. a trailing newline.
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") endField();
    else if (ch === "\n") endRow();
    else if (ch !== "\r") field += ch;
  }
  endRow();
  return rows;
}

const REQUIRED_HEADERS = [
  "부",
  "장소",
  "남성 이름",
  "남성 생년월일",
  "여성 이름",
  "여성 생년월일",
] as const;

const CODE_CSV_HEADER = "이름,성별,연락처,이메일,코드";

function isSession(value: string): value is Session {
  return value === "1부" || value === "2부";
}

/** Accepts YYYY-MM-DD only, and rejects dates the calendar does not have. */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === value;
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

export function parseMatchCsv(text: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const matches: ParsedMatch[] = [];

  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { matches, errors: ["파일이 비어 있습니다."], warnings };
  }

  const header = rows[0]!.map((cell) => cell.trim());
  const missing = REQUIRED_HEADERS.filter((name) => !header.includes(name));
  if (missing.length > 0) {
    errors.push(`필수 컬럼이 없습니다: ${missing.join(", ")}`);
    return { matches, errors, warnings };
  }

  if (rows.length === 1) {
    errors.push("데이터 행이 없습니다. 헤더만 있는 파일입니다.");
    return { matches, errors, warnings };
  }

  const columnIndex = new Map(header.map((name, index) => [name, index]));
  const cell = (row: string[], name: string): string =>
    (row[columnIndex.get(name) ?? -1] ?? "").trim();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    // Row numbers are 1-based and include the header, matching what the
    // organizer sees in Excel.
    const lineNo = i + 1;
    const rowErrors: string[] = [];

    const session = cell(row, "부");
    if (!isSession(session)) {
      rowErrors.push(`${lineNo}행: '부' 값이 '1부' 또는 '2부'가 아닙니다 ("${session}")`);
    }

    const venue = cell(row, "장소");
    if (venue === "") rowErrors.push(`${lineNo}행: '장소'가 비어 있습니다`);

    const people: Record<"male" | "female", ParsedPerson | null> = {
      male: null,
      female: null,
    };

    for (const [key, prefix, gender] of [
      ["male", "남성", "M"],
      ["female", "여성", "F"],
    ] as const) {
      const displayName = cell(row, `${prefix} 이름`);
      const birthdate = cell(row, `${prefix} 생년월일`);

      if (displayName === "") {
        rowErrors.push(`${lineNo}행: '${prefix} 이름'이 비어 있습니다`);
      }
      if (!isIsoDate(birthdate)) {
        rowErrors.push(
          `${lineNo}행: '${prefix} 생년월일'이 YYYY-MM-DD 형식이 아니거나 존재하지 않는 날짜입니다 ("${birthdate}")`,
        );
      }
      if (displayName !== "" && isIsoDate(birthdate)) {
        people[key] = {
          name: normalizeName(displayName),
          displayName,
          birthdate,
          gender,
          contact: blankToNull(cell(row, `${prefix} 연락처`)),
          email: blankToNull(cell(row, `${prefix} 이메일`)),
        };
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    const validSession = session as Session;
    const timeRange = cell(row, "시간") || SESSION_TIME[validSession];
    const arriveBy = (timeRange.split("~")[0] ?? "").trim();
    const team = blankToNull(cell(row, "조"));
    if (team === null) warnings.push(`${lineNo}행: '조'가 비어 있어 미정으로 저장됩니다`);

    matches.push({
      session: validSession,
      timeRange,
      arriveBy,
      venue,
      team,
      male: people.male!,
      female: people.female!,
    });
  }

  return { matches, errors, warnings };
}

/** Wraps a field in quotes when it contains a comma, quote, or newline. */
function escapeCsvField(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildCodesCsv(rows: CodeRow[]): string {
  const lines = [CODE_CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [
        row.displayName,
        row.gender === "M" ? "남" : "여",
        row.contact ?? "",
        row.email ?? "",
        // A null code means the participant kept the code they already had;
        // the plaintext is unrecoverable at that point.
        row.code === null ? "기존 코드 유지" : formatCode(row.code),
      ].map(escapeCsvField).join(","),
    );
  }
  return lines.join("\n");
}
