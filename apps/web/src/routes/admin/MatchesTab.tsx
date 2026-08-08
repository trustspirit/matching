import { useState } from "react";
import type {
  AdminMatchRow,
  AdminParticipantRow,
  Session,
} from "@shared/types.ts";
import { adminData, ApiError } from "../../api/client";
import { Button } from "../../design/Button";
import { Card } from "../../design/Card";
import { ParticipantPicker } from "./ParticipantPicker";

const MESSAGES: Record<string, string> = {
  invalid_request: "입력값을 확인해주세요.",
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
  password: string;
  matches: AdminMatchRow[];
  participants: AdminParticipantRow[];
  onChanged: () => void;
}

export function MatchesTab({
  password,
  matches,
  participants,
  onChanged,
}: MatchesTabProps) {
  // null = nothing being edited, "new" = the add form, otherwise a match id.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function report(caught: unknown): void {
    if (caught instanceof ApiError) {
      setError(MESSAGES[caught.code] ?? MESSAGES.server_error);
    } else {
      setError(MESSAGES.network_error);
    }
  }

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (editing === "new") {
        await adminData(password, "create_match", { ...draft });
      } else {
        await adminData(password, "update_match", { id: editing, ...draft });
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
      await adminData(password, "delete_match", { id });
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
        <div className="flex flex-wrap gap-md">
          <label className="flex flex-col gap-xs">
            <span className="type-caption-md text-mute">부</span>
            <select
              value={draft.session}
              onChange={(e) =>
                setDraft({ ...draft, session: e.target.value as Session })}
              className="type-body-md h-11 rounded-md border border-ash bg-canvas px-md text-ink"
            >
              <option value="1부">1부</option>
              <option value="2부">2부</option>
            </select>
          </label>

          {/* Written out rather than mapped over a field list: a computed key
              in an object spread widens to an index signature, so
              `{...draft, [field]: value}` stops type-checking as a Draft. */}
          <label className="flex flex-col gap-xs">
            <span className="type-caption-md text-mute">시간</span>
            <input
              value={draft.timeRange}
              placeholder="21:50~22:20"
              onChange={(e) => setDraft({ ...draft, timeRange: e.target.value })}
              className="type-body-md h-11 w-32 rounded-md border border-ash bg-canvas px-md text-ink"
            />
          </label>
          <label className="flex flex-col gap-xs">
            <span className="type-caption-md text-mute">도착</span>
            <input
              value={draft.arriveBy}
              placeholder="21:50"
              onChange={(e) => setDraft({ ...draft, arriveBy: e.target.value })}
              className="type-body-md h-11 w-32 rounded-md border border-ash bg-canvas px-md text-ink"
            />
          </label>
          <label className="flex flex-col gap-xs">
            <span className="type-caption-md text-mute">장소</span>
            <input
              value={draft.venue}
              placeholder="소극장"
              onChange={(e) => setDraft({ ...draft, venue: e.target.value })}
              className="type-body-md h-11 w-32 rounded-md border border-ash bg-canvas px-md text-ink"
            />
          </label>
          <label className="flex flex-col gap-xs">
            <span className="type-caption-md text-mute">조</span>
            <input
              value={draft.team}
              placeholder="3조"
              onChange={(e) => setDraft({ ...draft, team: e.target.value })}
              className="type-body-md h-11 w-32 rounded-md border border-ash bg-canvas px-md text-ink"
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-md">
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
      <div className="flex items-baseline justify-between">
        <p className="type-body-md text-mute">매칭 {matches.length}건</p>
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

      {error !== undefined && (
        <p role="alert" className="type-body-sm mt-md text-error">{error}</p>
      )}

      {editing === "new" && editor("new")}

      <div className="mt-lg flex flex-col">
        {matches.map((row) =>
          editing === row.id ? editor(row.id) : (
            <div
              key={row.id}
              className="type-body-sm flex flex-wrap items-center gap-md border-t border-hairline py-md text-body"
            >
              <span className="w-10 text-ink">{row.session}</span>
              <span className="w-32">{row.timeRange}</span>
              <span className="w-24">{row.venue}</span>
              <span className="w-16">{row.team ?? "미정"}</span>
              <span className="w-24 text-ink">{row.maleName}</span>
              <span className="w-24 text-ink">{row.femaleName}</span>
              <span className="ml-auto flex gap-xs">
                <Button
                  type="button"
                  variant="tertiary"
                  onClick={() => {
                    setDraft(toDraft(row));
                    setEditing(row.id);
                  }}
                >
                  수정
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
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
