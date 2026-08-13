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
  /** The viewer's own 조. */
  team: string | null;
  /**
   * The partner's 조. Separate from `team` because the two can differ, and the
   * result card shows both -- an unlabelled single 조 next to the partner's
   * name reads as the partner's whichever one it actually is.
   */
  partnerTeam: string | null;
  /**
   * Null until the session opens. The server withholds it rather than the
   * screen hiding it: a participant who opens the network tab before 9:50pm
   * must not find their partner's name sitting in the response.
   */
  partnerName: string | null;
  /**
   * When this session's partner becomes visible, as an ISO instant. Null once
   * that moment has passed, so a card either names the partner or says when it
   * will -- never both, and never neither.
   */
  revealAt: string | null;
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
  /**
   * 조 belongs to the person, not to the pairing: a match is assembled from two
   * participants, and each brings their own. Null until the organizer assigns
   * one.
   */
  team: string | null;
}

export interface ParsedMatch {
  session: Session;
  timeRange: string;
  arriveBy: string;
  venue: string;
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
  /** Each participant's own 조, carried over from their participant record. */
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
  /** The participant's 조, or null until one is assigned. */
  team: string | null;
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
