import { describe, expect, it } from "vitest";
import { buildCodesCsv, parseCsv, parseMatchCsv } from "./csv.ts";

const HEADER =
  "부,시간,장소,조,남성 이름,남성 생년월일,남성 연락처,남성 이메일,여성 이름,여성 생년월일,여성 연락처,여성 이메일";

const ROW_1 =
  "1부,21:50~22:20,소극장,3조,김효준,2004-06-24,010-389-5611,konanok20@gmail.com,정예림,2004-03-04,010-3793-8478,yljun3064@gmail.com";

// The organizer's real export: one 조 column per side, sitting next to that
// side's name columns, both spelled just "조".
const HEADER_2 =
  "부,시간,장소,조,남성 이름,남성 생년월일,남성 연락처,남성 이메일,조,여성 이름,여성 생년월일,여성 연락처,여성 이메일";

const ROW_2 =
  "1부,21:50~22:20,소극장,3조,김효준,2004-06-24,010-389-5611,konanok20@gmail.com,5조,정예림,2004-03-04,010-3793-8478,yljun3064@gmail.com";

describe("parseCsv", () => {
  it("splits plain rows on commas", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("keeps commas that are inside quotes", () => {
    expect(parseCsv('a,"b,c",d')).toEqual([["a", "b,c", "d"]]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('a,"say ""hi""",c')).toEqual([["a", 'say "hi"', "c"]]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("drops trailing blank lines", () => {
    expect(parseCsv("a,b\n1,2\n\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("keeps an interior blank row and still drops trailing ones", () => {
    expect(parseCsv("a,b\n\n1,2\n\n")).toEqual([["a", "b"], [""], ["1", "2"]]);
  });

  it("treats a stray quote mid-field as a literal character", () => {
    expect(parseCsv('a,b"c,d')).toEqual([["a", 'b"c', "d"]]);
  });

  it("still opens a quoted field when the quote starts the field", () => {
    expect(parseCsv('a,"b,c",d')).toEqual([["a", "b,c", "d"]]);
  });
});

describe("parseMatchCsv", () => {
  it("parses a well-formed row into a match", () => {
    const result = parseMatchCsv(`${HEADER}\n${ROW_1}`);
    expect(result.errors).toEqual([]);
    expect(result.matches).toHaveLength(1);

    const match = result.matches[0]!;
    expect(match.session).toBe("1부");
    expect(match.timeRange).toBe("21:50~22:20");
    expect(match.arriveBy).toBe("21:50");
    expect(match.venue).toBe("소극장");
    // A single 조 column applies to both sides of the pair.
    expect(match.maleTeam).toBe("3조");
    expect(match.femaleTeam).toBe("3조");
    expect(match.male.displayName).toBe("김효준");
    expect(match.male.name).toBe("김효준");
    expect(match.male.gender).toBe("M");
    expect(match.female.displayName).toBe("정예림");
    expect(match.female.gender).toBe("F");
  });

  it("derives the time range from the session when 시간 is blank", () => {
    const row = ROW_1.replace("21:50~22:20", "");
    const result = parseMatchCsv(`${HEADER}\n${row}`);
    expect(result.errors).toEqual([]);
    expect(result.matches[0]!.timeRange).toBe("21:50~22:20");
    expect(result.matches[0]!.arriveBy).toBe("21:50");
  });

  it("uses the 2부 schedule for 2부 rows", () => {
    const row = ROW_1.replace("1부", "2부").replace("21:50~22:20", "");
    const result = parseMatchCsv(`${HEADER}\n${row}`);
    expect(result.matches[0]!.timeRange).toBe("22:40~23:00");
    expect(result.matches[0]!.arriveBy).toBe("22:40");
  });

  it("treats a blank 조 as undecided and warns", () => {
    const row = ROW_1.replace(",3조,", ",,");
    const result = parseMatchCsv(`${HEADER}\n${row}`);
    expect(result.errors).toEqual([]);
    expect(result.matches[0]!.maleTeam).toBeNull();
    expect(result.matches[0]!.femaleTeam).toBeNull();
    // One shared column means one thing is missing, so one warning.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("2행");
  });

  it("reads a per-side 조 from each of the two 조 columns", () => {
    const result = parseMatchCsv(`${HEADER_2}\n${ROW_2}`);
    expect(result.errors).toEqual([]);
    expect(result.matches[0]!.maleTeam).toBe("3조");
    expect(result.matches[0]!.femaleTeam).toBe("5조");
  });

  it("warns per side when only one of the two 조 columns is blank", () => {
    const row = ROW_2.replace(",5조,", ",,");
    const result = parseMatchCsv(`${HEADER_2}\n${row}`);
    expect(result.errors).toEqual([]);
    expect(result.matches[0]!.maleTeam).toBe("3조");
    expect(result.matches[0]!.femaleTeam).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("여성 조");
  });

  it("prefers explicitly named 남성 조 / 여성 조 headers", () => {
    const header = HEADER_2
      .replace("조,남성 이름", "남성 조,남성 이름")
      .replace("조,여성 이름", "여성 조,여성 이름");
    const result = parseMatchCsv(`${header}\n${ROW_2}`);
    expect(result.errors).toEqual([]);
    expect(result.matches[0]!.maleTeam).toBe("3조");
    expect(result.matches[0]!.femaleTeam).toBe("5조");
  });

  it("rejects a header with more than two 조 columns", () => {
    const result = parseMatchCsv(`${HEADER_2},조\n${ROW_2},7조`);
    expect(result.matches).toEqual([]);
    expect(result.errors.join(" ")).toContain("조");
  });

  it("rejects a spreadsheet error value in 조 instead of storing it", () => {
    const row = ROW_2.replace(",3조,", ",#NAME?,").replace(",5조,", ",#NAME?,");
    const result = parseMatchCsv(`${HEADER_2}\n${row}`);
    expect(result.matches).toEqual([]);
    expect(result.errors[0]).toContain("2행");
    expect(result.errors[0]).toContain("#NAME?");
  });

  it("rejects a spreadsheet error value in any column it reads", () => {
    const row = ROW_1.replace("konanok20@gmail.com", "#REF!");
    const result = parseMatchCsv(`${HEADER}\n${row}`);
    expect(result.matches).toEqual([]);
    expect(result.errors[0]).toContain("남성 이메일");
    expect(result.errors[0]).toContain("#REF!");
  });

  it("normalizes an aliased name while keeping the original spelling", () => {
    const row = ROW_1.replace("김효준", "이승호- lee Seung ho");
    const result = parseMatchCsv(`${HEADER}\n${row}`);
    expect(result.matches[0]!.male.name).toBe("이승호");
    expect(result.matches[0]!.male.displayName).toBe("이승호- lee Seung ho");
  });

  it("reports missing required headers and parses nothing", () => {
    const result = parseMatchCsv("부,장소\n1부,소극장");
    expect(result.matches).toEqual([]);
    expect(result.errors.join(" ")).toContain("남성 이름");
  });

  it("reports an unknown 부 value with its row number", () => {
    const row = ROW_1.replace("1부", "3부");
    const result = parseMatchCsv(`${HEADER}\n${row}`);
    expect(result.matches).toEqual([]);
    expect(result.errors[0]).toContain("2행");
    expect(result.errors[0]).toContain("부");
  });

  it("reports a malformed birthdate with its row number", () => {
    const row = ROW_1.replace("2004-06-24", "2004/06/24");
    const result = parseMatchCsv(`${HEADER}\n${row}`);
    expect(result.errors[0]).toContain("2행");
    expect(result.errors[0]).toContain("생년월일");
  });

  it("rejects a calendar-invalid date", () => {
    const row = ROW_1.replace("2004-06-24", "2004-02-30");
    const result = parseMatchCsv(`${HEADER}\n${row}`);
    expect(result.errors).toHaveLength(1);
  });

  it("reports a blank required name", () => {
    const row = ROW_1.replace(",김효준,", ",,");
    const result = parseMatchCsv(`${HEADER}\n${row}`);
    expect(result.errors[0]).toContain("2행");
  });

  it("collects every failing row, not just the first", () => {
    const bad1 = ROW_1.replace("1부", "3부");
    const bad2 = ROW_1.replace("2004-06-24", "nope");
    const result = parseMatchCsv(`${HEADER}\n${bad1}\n${bad2}`);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("2행");
    expect(result.errors[1]).toContain("3행");
  });

  it("ignores columns it does not know about", () => {
    const header = `${HEADER},나이 차이,일치 개수`;
    const row = `${ROW_1},0,8`;
    const result = parseMatchCsv(`${header}\n${row}`);
    expect(result.errors).toEqual([]);
    expect(result.matches).toHaveLength(1);
  });

  it("treats blank contact and email as null", () => {
    const row = ROW_1
      .replace("010-389-5611", "")
      .replace("konanok20@gmail.com", "");
    const result = parseMatchCsv(`${HEADER}\n${row}`);
    expect(result.matches[0]!.male.contact).toBeNull();
    expect(result.matches[0]!.male.email).toBeNull();
  });

  it("errors when the file has no data rows", () => {
    const result = parseMatchCsv(HEADER);
    expect(result.errors.join(" ")).toContain("데이터 행");
  });

  it("still reports no data rows when the file is a header plus blank lines", () => {
    const result = parseMatchCsv(`${HEADER}\n\n\n`);
    expect(result.errors.join(" ")).toContain("데이터 행");
  });

  it("does not let a mid-file blank row shift later row numbers", () => {
    const bad = ROW_1.replace("1부", "3부");
    // header=1행, ROW_1=2행, blank=3행, bad=4행
    const result = parseMatchCsv(`${HEADER}\n${ROW_1}\n\n${bad}`);
    expect(result.matches).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("4행");
  });
});

describe("buildCodesCsv", () => {
  it("writes a header and one line per row", () => {
    const csv = buildCodesCsv([
      {
        displayName: "김효준",
        gender: "M",
        contact: "010-389-5611",
        email: "konanok20@gmail.com",
        code: "K7M2QX",
      },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("이름,성별,연락처,이메일,코드");
    expect(lines[1]).toBe("김효준,남,010-389-5611,konanok20@gmail.com,K7M2QX");
  });

  it("marks participants who kept an existing code", () => {
    const csv = buildCodesCsv([
      { displayName: "정예림", gender: "F", contact: null, email: null, code: null },
    ]);
    expect(csv.split("\n")[1]).toBe("정예림,여,,,기존 코드 유지");
  });

  it("quotes fields that contain a comma", () => {
    const csv = buildCodesCsv([
      {
        displayName: "Flores, Romrik Joshua",
        gender: "M",
        contact: "IG: @x | KaKaoTalk: y",
        email: null,
        code: "ABC234",
      },
    ]);
    expect(csv.split("\n")[1]).toContain('"Flores, Romrik Joshua"');
  });
});
