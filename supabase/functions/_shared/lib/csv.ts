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
  // Tracks whether any character (quote or otherwise) has already been
  // consumed for the current field. A quote only opens a quoted field when
  // it is the field's very first character; a quote appearing after that is
  // kept as a literal character (RFC 4180).
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    // Every physical line becomes a row here, including blank ones — the
    // caller's index must stay aligned with the file's line numbers.
    // Trailing blank rows are trimmed once, after the whole file is parsed.
    rows.push(row);
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
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRow();
    } else if (ch !== "\r") {
      field += ch;
      fieldStarted = true;
    }
  }
  endRow();

  // Strip a trailing run of blank rows: the phantom row a final newline
  // produces, plus any blank separator lines left at EOF. Interior blank
  // rows are preserved so a row's index here stays aligned with its
  // physical line number in the source file.
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c.trim() === "")) {
    rows.pop();
  }

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

/**
 * Values Excel and Google Sheets write into a cell when its formula fails.
 * They survive a CSV export as ordinary text, so nothing downstream can tell
 * them apart from a real answer -- "#NAME?" is a perfectly valid string as far
 * as the database is concerned. Catching them here is the only place the
 * organizer still has the source sheet in front of them.
 */
const SPREADSHEET_ERROR_VALUES = new Set([
  "#NAME?",
  "#REF!",
  "#VALUE!",
  "#DIV/0!",
  "#N/A",
  "#NUM!",
  "#NULL!",
  "#ERROR!",
  "#SPILL!",
  "#CALC!",
  "#FIELD!",
  "#BLOCKED!",
  "#CONNECT!",
  "#UNKNOWN!",
  "#GETTING_DATA",
]);

function isSpreadsheetError(value: string): boolean {
  return SPREADSHEET_ERROR_VALUES.has(value.toUpperCase());
}

/** A 조 column resolved to one side of the pair. */
interface TeamColumn {
  /** Header text to quote back in messages -- "조", "남성 조", or "여성 조". */
  label: string;
  index: number;
}

interface TeamColumns {
  male: TeamColumn | null;
  female: TeamColumn | null;
  /** Set when the header is too ambiguous to resolve at all. */
  error?: string;
}

/**
 * The organizer's export carries one 조 column per side, and both are spelled
 * just "조" -- the side is implied by the column's position next to that side's
 * name columns. A name-keyed lookup collapses the two into one, so the columns
 * have to be resolved by occurrence instead.
 *
 * Explicitly named "남성 조" / "여성 조" headers win when present, so a sheet
 * can disambiguate itself without depending on column order.
 */
function resolveTeamColumns(header: string[]): TeamColumns {
  const namedMale = header.indexOf("남성 조");
  const namedFemale = header.indexOf("여성 조");
  if (namedMale !== -1 || namedFemale !== -1) {
    return {
      male: namedMale === -1 ? null : { label: "남성 조", index: namedMale },
      female: namedFemale === -1 ? null : { label: "여성 조", index: namedFemale },
    };
  }

  const plain: number[] = [];
  header.forEach((name, index) => {
    if (name === "조") plain.push(index);
  });

  // One column is the older single-조 layout: the pair shares a group.
  if (plain.length === 1) {
    const shared = { label: "조", index: plain[0]! };
    return { male: shared, female: shared };
  }
  if (plain.length === 2) {
    return {
      male: { label: "남성 조", index: plain[0]! },
      female: { label: "여성 조", index: plain[1]! },
    };
  }
  if (plain.length > 2) {
    return {
      male: null,
      female: null,
      error:
        `'조' 컬럼이 ${plain.length}개입니다. 남성/여성 각각 1개씩만 두거나, '남성 조'/'여성 조'로 이름을 구분해주세요.`,
    };
  }
  return { male: null, female: null };
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

  const teams = resolveTeamColumns(header);
  if (teams.error !== undefined) {
    errors.push(teams.error);
    return { matches, errors, warnings };
  }

  // First occurrence wins for a repeated header. Only 조 legitimately repeats
  // (see resolveTeamColumns), and it is resolved by position instead; for any
  // other accidental duplicate, the leftmost column is the predictable choice.
  const columnIndex = new Map<string, number>();
  header.forEach((name, index) => {
    if (!columnIndex.has(name)) columnIndex.set(name, index);
  });
  const cellAt = (row: string[], index: number): string =>
    (row[index] ?? "").trim();
  const cell = (row: string[], name: string): string =>
    cellAt(row, columnIndex.get(name) ?? -1);

  // Every column whose value ends up inside a match record. A formula error in
  // any of them has to be caught before it is stored, so they are collected
  // once here and scanned per row. Deduped by index because a shared 조 column
  // would otherwise be reported twice for the same cell.
  const readColumns: TeamColumn[] = [];
  const addReadColumn = (label: string, index: number | undefined): void => {
    if (index === undefined || index < 0) return;
    if (readColumns.some((c) => c.index === index)) return;
    readColumns.push({ label, index });
  };
  for (const name of ["부", "시간", "장소"]) {
    addReadColumn(name, columnIndex.get(name));
  }
  for (const side of [teams.male, teams.female]) {
    if (side !== null) addReadColumn(side.label, side.index);
  }
  for (const prefix of ["남성", "여성"]) {
    for (const suffix of ["이름", "생년월일", "연락처", "이메일"]) {
      const name = `${prefix} ${suffix}`;
      addReadColumn(name, columnIndex.get(name));
    }
  }

  // Both sides pointing at the same column is the older single-조 layout: one
  // blank cell there is one missing value, so it warns once rather than twice.
  const sharedTeamColumn = teams.male !== null &&
    teams.male.index === teams.female?.index;
  const hasTeamColumn = teams.male !== null || teams.female !== null;
  if (!hasTeamColumn) {
    warnings.push("'조' 컬럼이 없어 모든 조가 미정으로 저장됩니다.");
  }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    // Row numbers are 1-based and include the header, matching what the
    // organizer sees in Excel. lineNo is derived from the raw row index, not
    // from how many data rows have been seen, so a blank separator row
    // anywhere in the file does not shift the numbering of the rows after it.
    const lineNo = i + 1;

    // A blank line (e.g. a spacer between the 1부 and 2부 blocks) carries no
    // data and is not an error — just skip it.
    if (row.every((c) => c.trim() === "")) continue;

    const rowErrors: string[] = [];

    // Checked before anything else: a formula error is text, so every check
    // below would happily accept it and the value would land in the database
    // looking like a real answer. Rejecting the row sends the organizer back
    // to the sheet, which is the only place the value can actually be fixed.
    for (const column of readColumns) {
      const value = cellAt(row, column.index);
      if (isSpreadsheetError(value)) {
        rowErrors.push(
          `${lineNo}행: '${column.label}'에 스프레드시트 수식 오류가 들어 있습니다 ("${value}"). ` +
            "원본 시트에서 값으로 붙여넣기(Ctrl+Shift+V) 한 뒤 다시 내보내주세요",
        );
      }
    }
    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

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
    const teamOf = (side: TeamColumn | null): string | null =>
      side === null ? null : blankToNull(cellAt(row, side.index));
    const maleTeam = teamOf(teams.male);
    const femaleTeam = teamOf(teams.female);
    if (hasTeamColumn) {
      const blank: TeamColumn[] = [];
      if (maleTeam === null && teams.male !== null) blank.push(teams.male);
      // A shared column is already covered by the male entry above.
      if (femaleTeam === null && teams.female !== null && !sharedTeamColumn) {
        blank.push(teams.female);
      }
      for (const column of blank) {
        warnings.push(`${lineNo}행: '${column.label}'이 비어 있어 미정으로 저장됩니다`);
      }
    }

    matches.push({
      session: validSession,
      timeRange,
      arriveBy,
      venue,
      maleTeam,
      femaleTeam,
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
        row.code === null ? "기존 코드 유지" : row.code,
      ].map(escapeCsvField).join(","),
    );
  }
  return lines.join("\n");
}
