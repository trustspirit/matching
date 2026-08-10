export type Session = "1부" | "2부";

/** Fixed schedule for each session. Used when the CSV omits the 시간 column. */
export const SESSION_TIME: Record<Session, string> = {
  "1부": "21:50~22:20",
  "2부": "22:40~23:00",
};

/** One match as shown to the participant. */
export interface MatchView {
  session: Session;
  timeRange: string;
  arriveBy: string;
  venue: string;
  /** This participant's own 조 -- their partner may be in a different one. */
  team: string | null;
  partnerName: string;
}

export interface LookupResponse {
  displayName: string;
  matches: MatchView[];
}

export interface ParsedPerson {
  /** Normalized lookup key. */
  name: string;
  /** Original spelling, shown in the UI. */
  displayName: string;
  /** ISO date, YYYY-MM-DD. */
  birthdate: string;
  gender: "M" | "F";
  contact: string | null;
  email: string | null;
}

export interface ParsedMatch {
  session: Session;
  timeRange: string;
  arriveBy: string;
  venue: string;
  /**
   * 조 is recorded per side: the organizer's sheet carries a 조 column next to
   * each side's name columns, and the two can differ. A sheet with a single 조
   * column puts the same value in both.
   */
  maleTeam: string | null;
  femaleTeam: string | null;
  male: ParsedPerson;
  female: ParsedPerson;
}

export interface ParseResult {
  matches: ParsedMatch[];
  /** Blocking problems. A non-empty list means nothing is written to the DB. */
  errors: string[];
  /** Non-blocking notes, surfaced in the admin UI. */
  warnings: string[];
}

/** One match row as shown in the admin table. */
export interface AdminMatchRow {
  id: string;
  session: Session;
  timeRange: string;
  arriveBy: string;
  venue: string;
  /** Each side's own 조; the two can differ. */
  maleTeam: string | null;
  femaleTeam: string | null;
  maleId: string;
  maleName: string;
  maleBirthdate: string;
  femaleId: string;
  femaleName: string;
  femaleBirthdate: string;
}

/** One participant row as shown in the admin table. */
export interface AdminParticipantRow {
  id: string;
  displayName: string;
  birthdate: string;
  gender: "M" | "F";
  contact: string | null;
  email: string | null;
  /**
   * When this participant was emailed the code they currently hold, or null if
   * they never were. Minting a code clears it, so a null here always means the
   * live code has not gone out.
   */
  codeSentAt: string | null;
}

/** What deleting a participant would take with it. */
export interface ImpactRow {
  session: Session;
  venue: string;
  /** The 조 of the participant being deleted, not the pair's. */
  team: string | null;
  partnerName: string;
}

/** One line of the code CSV handed back to the organizer after an import. */
export interface CodeRow {
  displayName: string;
  gender: "M" | "F";
  contact: string | null;
  email: string | null;
  /** null when the participant already existed and kept their previous code. */
  code: string | null;
}
