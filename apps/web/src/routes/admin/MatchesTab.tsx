import { useMemo, useState } from "react";
import type {
  AdminMatchRow,
  AdminParticipantRow,
  Session,
} from "@shared/types.ts";
import { adminData, ApiError } from "../../api/client";
import { Button, ROW_BUTTON } from "../../design/Button";
import { Card } from "../../design/Card";
import { SearchInput } from "../../design/SearchInput";
import { Select } from "../../design/Select";
import { categoryColor, categoryValues } from "../../lib/categoryColor";
import { nameMatches } from "../../lib/nameFilter";
import { ParticipantPicker } from "./ParticipantPicker";

const MESSAGES: Record<string, string> = {
  invalid_request: "입력값을 확인해주세요.",
  same_person: "같은 사람을 남성과 여성 양쪽에 넣을 수 없습니다.",
  wrong_gender: "남성 칸에는 남성을, 여성 칸에는 여성을 넣어주세요.",
  not_found: "이미 삭제된 항목입니다. 새로고침 후 다시 시도해주세요.",
  unauthorized: "비밀번호가 올바르지 않습니다.",
  too_many_attempts: "시도가 너무 많습니다. 잠시 후 다시 시도해주세요.",
  network_error: "연결에 실패했습니다. 다시 시도해주세요.",
  server_error: "서버 오류가 발생했습니다.",
};

interface Draft {
  session: Session;
  timeRange: string;
  arriveBy: string;
  venue: string;
  team: string;
  maleId: string;
  femaleId: string;
}

const BLANK: Draft = {
  session: "1부",
  timeRange: "",
  arriveBy: "",
  venue: "",
  team: "",
  maleId: "",
  femaleId: "",
};

function toDraft(row: AdminMatchRow): Draft {
  return {
    session: row.session,
    timeRange: row.timeRange,
    arriveBy: row.arriveBy,
    venue: row.venue,
    team: row.team ?? "",
    maleId: row.maleId,
    femaleId: row.femaleId,
  };
}

interface MatchesTabProps {
  token: string;
  matches: AdminMatchRow[];
  participants: AdminParticipantRow[];
  onChanged: () => void;
}

export function MatchesTab({
  token,
  matches,
  participants,
  onChanged,
}: MatchesTabProps) {
  // null = nothing being edited, "new" = the add form, otherwise a match id.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [sessionFilter, setSessionFilter] = useState("전체");
  const [venueFilter, setVenueFilter] = useState("전체");
  const [nameQuery, setNameQuery] = useState("");

  // Derived from every match, never from the filtered subset: a colour has to
  // stay with its venue even when a filter hides the others.
  const sessions = useMemo(
    () => categoryValues(matches.map((m) => m.session)),
    [matches],
  );
  const venues = useMemo(
    () => categoryValues(matches.map((m) => m.venue)),
    [matches],
  );
  const visible = useMemo(
    () =>
      matches.filter((m) =>
        (sessionFilter === "전체" || m.session === sessionFilter) &&
        (venueFilter === "전체" || m.venue === venueFilter) &&
        // Either partner's name counts: the operator looking someone up does
        // not know which side of the pairing they are on.
        nameMatches(nameQuery, m.maleName, m.femaleName)
      ),
    [matches, sessionFilter, venueFilter, nameQuery],
  );

  function report(caught: unknown): void {
    if (!(caught instanceof ApiError)) {
      setError(MESSAGES.network_error);
      return;
    }
    // Built here rather than server-side: the server returns the facts, the
    // screen owns the wording.
    if (caught.code === "already_scheduled") {
      const name = caught.info?.name;
      const at = caught.info?.existing as
        | { session: string; timeRange: string; venue: string }
        | undefined;
      setError(
        at === undefined
          ? "이미 같은 부에 배정된 사람이 있습니다."
          : `${name}님은 이미 ${at.session} ${at.timeRange} ${at.venue}에 배정되어 ` +
            "있습니다. 같은 부에 두 번 넣을 수 없습니다.",
      );
      return;
    }
    setError(MESSAGES[caught.code] ?? MESSAGES.server_error);
  }

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (editing === "new") {
        await adminData(token, "create_match", { ...draft });
      } else {
        await adminData(token, "update_match", { id: editing, ...draft });
      }
      setEditing(null);
      onChanged();
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    if (busy) return;
    if (!globalThis.confirm("이 매칭을 삭제합니다. 계속할까요?")) return;
    setBusy(true);
    setError(undefined);
    try {
      await adminData(token, "delete_match", { id });
      onChanged();
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  function editor(key: string) {
    return (
      <div
        key={key}
        className="flex flex-col gap-md border-t border-hairline py-lg"
      >
        {/* One column on a phone, wrapping row from md up. The inputs are
            full-width by default and only take a fixed width once there is
            room for several on a line. */}
        <div className="flex flex-col gap-md md:flex-row md:flex-wrap">
          <Select
            label="부"
            value={draft.session}
            onChange={(e) =>
              setDraft({ ...draft, session: e.target.value as Session })}
            className="md:w-24"
          >
            <option value="1부">1부</option>
            <option value="2부">2부</option>
          </Select>

          {/* Written out rather than mapped over a field list: a computed key
              in an object spread widens to an index signature, so
              `{...draft, [field]: value}` stops type-checking as a Draft. */}
          <label className="flex flex-col gap-xs">
            <span className="type-caption-md text-mute">시간</span>
            <input
              value={draft.timeRange}
              placeholder="21:50~22:20"
              onChange={(e) => setDraft({ ...draft, timeRange: e.target.value })}
              className="type-body-md h-11 w-full rounded-md border border-ash bg-canvas px-md text-ink md:w-36"
            />
          </label>
          <label className="flex flex-col gap-xs">
            <span className="type-caption-md text-mute">도착</span>
            <input
              value={draft.arriveBy}
              placeholder="21:50"
              onChange={(e) => setDraft({ ...draft, arriveBy: e.target.value })}
              className="type-body-md h-11 w-full rounded-md border border-ash bg-canvas px-md text-ink md:w-28"
            />
          </label>
          <label className="flex flex-col gap-xs">
            <span className="type-caption-md text-mute">장소</span>
            <input
              value={draft.venue}
              placeholder="소극장"
              onChange={(e) => setDraft({ ...draft, venue: e.target.value })}
              className="type-body-md h-11 w-full rounded-md border border-ash bg-canvas px-md text-ink md:w-32"
            />
          </label>
          <label className="flex flex-col gap-xs">
            <span className="type-caption-md text-mute">조</span>
            <input
              value={draft.team}
              placeholder="3조"
              onChange={(e) => setDraft({ ...draft, team: e.target.value })}
              className="type-body-md h-11 w-full rounded-md border border-ash bg-canvas px-md text-ink md:w-24"
            />
          </label>
        </div>

        <div className="flex flex-col gap-md md:flex-row md:flex-wrap">
          <ParticipantPicker
            label="남성"
            gender="M"
            participants={participants}
            valueId={draft.maleId}
            onSelect={(id) => setDraft({ ...draft, maleId: id })}
          />
          <ParticipantPicker
            label="여성"
            gender="F"
            participants={participants}
            valueId={draft.femaleId}
            onSelect={(id) => setDraft({ ...draft, femaleId: id })}
          />
        </div>

        <div className="flex gap-sm">
          <Button type="button" onClick={() => void save()} loading={busy}>
            저장
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setEditing(null)}
          >
            취소
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-md">
        <Select
          compact
          label="부"
          value={sessionFilter}
          onChange={(e) => setSessionFilter(e.target.value)}
          className="w-28"
        >
          <option value="전체">전체</option>
          {sessions.map((v) => <option key={v} value={v}>{v}</option>)}
        </Select>
        <Select
          compact
          label="장소"
          value={venueFilter}
          onChange={(e) => setVenueFilter(e.target.value)}
          className="w-36"
        >
          <option value="전체">전체</option>
          {venues.map((v) => <option key={v} value={v}>{v}</option>)}
        </Select>

        <SearchInput
          label="이름"
          value={nameQuery}
          onValueChange={setNameQuery}
          placeholder="김철수"
          className="w-40"
        />

        <p className="type-body-md text-mute">
          {visible.length === matches.length
            ? `매칭 ${matches.length}건`
            : `매칭 ${visible.length} / ${matches.length}건`}
        </p>

        <div className="ml-auto">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setDraft(BLANK);
              setEditing("new");
            }}
          >
            + 매칭 추가
          </Button>
        </div>
      </div>

      {error !== undefined && (
        <p role="alert" className="type-body-sm mt-md text-error">{error}</p>
      )}

      {editing === "new" && editor("new")}

      {/* Column headers only make sense in the wide table layout; the narrow
          layout stacks each row into a self-labelling card. */}
      <div className="type-caption-md mt-lg hidden border-b border-hairline pb-xs text-mute md:flex md:gap-md">
        <span className="w-16">부</span>
        <span className="w-16">조</span>
        <span className="w-32">시간</span>
        <span className="w-24">장소</span>
        <span className="w-24">남성</span>
        <span className="w-24">여성</span>
      </div>

      {/* The header carries the gap from the controls above, but it is hidden
          below md -- so the rows take that gap over at narrow widths, or the
          first row's top border lands flush against the filter row. */}
      <div className="mt-lg flex flex-col md:mt-0">
        {visible.map((row) =>
          editing === row.id ? editor(row.id) : (
            // Stacked card on a phone, single table row from md up. The inner
            // wrappers group related fields while stacked; `md:contents` makes
            // them disappear from the layout at md so their children line up
            // as columns of one row instead of duplicating the markup.
            <div
              key={row.id}
              // No wrapping from md up: the columns and the action group have
              // to stay on one line, or the buttons drop to a second row and
              // stop lining up with the record they act on.
              className="type-body-sm flex flex-col gap-xs border-t border-hairline py-md text-body md:flex-row md:flex-nowrap md:items-center md:gap-md"
            >
              <div className="flex items-center gap-md md:contents">
                <span className="md:w-16">
                  <span
                    className="type-caption-md rounded-sm px-xs py-xxs"
                    style={{
                      backgroundColor: categoryColor(row.session, sessions).bg,
                      color: categoryColor(row.session, sessions).fg,
                    }}
                  >
                    {row.session}
                  </span>
                </span>
                <span className="text-ink md:w-16">{row.team ?? "미정"}</span>
              </div>
              <div className="flex items-center gap-md md:contents">
                <span className="md:w-32">{row.timeRange}</span>
                <span className="md:w-24">
                  <span
                    className="type-caption-md rounded-sm px-xs py-xxs"
                    style={{
                      backgroundColor: categoryColor(row.venue, venues, sessions.length).bg,
                      color: categoryColor(row.venue, venues, sessions.length).fg,
                    }}
                  >
                    {row.venue}
                  </span>
                </span>
              </div>
              <div className="flex gap-xs md:contents">
                <span className="text-ink md:w-24">{row.maleName}</span>
                <span className="text-mute md:hidden">—</span>
                <span className="text-ink md:w-24">{row.femaleName}</span>
              </div>
              <span className="flex gap-xs md:ml-auto md:shrink-0 md:gap-0">
                <Button
                  type="button"
                  variant="tertiary"
                  className={ROW_BUTTON}
                  onClick={() => {
                    setDraft(toDraft(row));
                    setEditing(row.id);
                  }}
                >
                  수정
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  className={ROW_BUTTON}
                  onClick={() => void remove(row.id)}
                >
                  삭제
                </Button>
              </span>
            </div>
          )
        )}
      </div>
    </Card>
  );
}
