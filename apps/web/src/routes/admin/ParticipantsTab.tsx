import { useState } from "react";
import type { AdminParticipantRow, ImpactRow } from "@shared/types.ts";
import { adminData, ApiError } from "../../api/client";
import { Button } from "../../design/Button";
import { Card } from "../../design/Card";
import { Select } from "../../design/Select";
import { CodeReveal } from "./CodeReveal";
import { DeleteParticipantDialog } from "./DeleteParticipantDialog";

const MESSAGES: Record<string, string> = {
  invalid_request: "입력값을 확인해주세요.",
  duplicate_participant: "이미 같은 이름·생년월일의 참가자가 있습니다.",
  not_found: "이미 삭제된 항목입니다. 새로고침 후 다시 시도해주세요.",
  unauthorized: "비밀번호가 올바르지 않습니다.",
  too_many_attempts: "시도가 너무 많습니다. 잠시 후 다시 시도해주세요.",
  network_error: "연결에 실패했습니다. 다시 시도해주세요.",
  server_error: "서버 오류가 발생했습니다.",
};

interface Draft {
  displayName: string;
  birthdate: string;
  gender: "M" | "F";
  contact: string;
  email: string;
}

const BLANK: Draft = {
  displayName: "",
  birthdate: "",
  gender: "M",
  contact: "",
  email: "",
};

function toDraft(row: AdminParticipantRow): Draft {
  return {
    displayName: row.displayName,
    birthdate: row.birthdate,
    gender: row.gender,
    contact: row.contact ?? "",
    email: row.email ?? "",
  };
}

interface Revealed {
  name: string;
  code: string;
}

interface Deleting {
  row: AdminParticipantRow;
  impact: ImpactRow[];
}

interface ParticipantsTabProps {
  token: string;
  participants: AdminParticipantRow[];
  onChanged: () => void;
}

export function ParticipantsTab({
  token,
  participants,
  onChanged,
}: ParticipantsTabProps) {
  // null = nothing being edited, "new" = the add form, otherwise a row id.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
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
        const created = await adminData<{ id: string; code: string }>(
          token,
          "create_participant",
          { ...draft },
        );
        setRevealed({ name: draft.displayName, code: created.code });
      } else {
        await adminData(token, "update_participant", {
          id: editing,
          ...draft,
        });
      }
      setEditing(null);
      onChanged();
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  async function reissue(row: AdminParticipantRow): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await adminData<{ code: string }>(
        token,
        "regenerate_code",
        { id: row.id },
      );
      setRevealed({ name: row.displayName, code: result.code });
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  async function askDelete(row: AdminParticipantRow): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await adminData<{ matches: ImpactRow[] }>(
        token,
        "participant_impact",
        { id: row.id },
      );
      setDeleting({ row, impact: result.matches });
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (deleting === null || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await adminData(token, "delete_participant", { id: deleting.row.id });
      setDeleting(null);
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
        className="flex flex-col gap-md border-t border-hairline py-lg md:flex-row md:flex-wrap md:items-end"
      >
        <label className="flex flex-col gap-xs">
          <span className="type-caption-md text-mute">이름</span>
          <input
            value={draft.displayName}
            placeholder="홍길동"
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
            className="type-body-md h-11 w-full rounded-md border border-ash bg-canvas px-md text-ink md:w-32"
          />
        </label>
        <label className="flex flex-col gap-xs">
          <span className="type-caption-md text-mute">생년월일</span>
          <input
            value={draft.birthdate}
            placeholder="1999-01-02"
            onChange={(e) => setDraft({ ...draft, birthdate: e.target.value })}
            className="type-body-md h-11 w-full rounded-md border border-ash bg-canvas px-md text-ink md:w-36"
          />
        </label>
        <Select
          label="성별"
          value={draft.gender}
          onChange={(e) =>
            setDraft({ ...draft, gender: e.target.value as "M" | "F" })}
          className="md:w-24"
        >
          <option value="M">남</option>
          <option value="F">여</option>
        </Select>
        <label className="flex flex-col gap-xs">
          <span className="type-caption-md text-mute">연락처</span>
          <input
            value={draft.contact}
            placeholder="010-0000-0000"
            onChange={(e) => setDraft({ ...draft, contact: e.target.value })}
            className="type-body-md h-11 w-full rounded-md border border-ash bg-canvas px-md text-ink md:w-40"
          />
        </label>
        <label className="flex flex-col gap-xs">
          <span className="type-caption-md text-mute">이메일</span>
          <input
            value={draft.email}
            placeholder="a@example.com"
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            className="type-body-md h-11 w-full rounded-md border border-ash bg-canvas px-md text-ink md:w-56"
          />
        </label>

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
      <div className="flex flex-wrap items-baseline justify-between gap-md">
        <p className="type-body-md text-mute">참가자 {participants.length}명</p>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setDraft(BLANK);
            setEditing("new");
          }}
        >
          + 참가자 추가
        </Button>
      </div>

      {error !== undefined && (
        <p role="alert" className="type-body-sm mt-md text-error">{error}</p>
      )}

      {revealed !== null && (
        <CodeReveal
          name={revealed.name}
          code={revealed.code}
          onDismiss={() => setRevealed(null)}
        />
      )}

      {deleting !== null && (
        <DeleteParticipantDialog
          name={deleting.row.displayName}
          birthdate={deleting.row.birthdate}
          impact={deleting.impact}
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}

      {editing === "new" && editor("new")}

      <div className="mt-lg flex flex-col">
        {participants.map((p) =>
          editing === p.id ? editor(p.id) : (
            // Stacked card on a phone, single table row from md up.
            // `md:contents` dissolves the grouping wrappers at md so their
            // children become columns of one row without duplicated markup.
            <div
              key={p.id}
              className="type-body-sm flex flex-col gap-xs border-t border-hairline py-md text-body md:flex-row md:flex-wrap md:items-center md:gap-md"
            >
              <div className="flex gap-md md:contents">
                <span className="type-body-sm-strong text-ink md:w-24 md:font-normal">
                  {p.displayName}
                </span>
                <span className="md:w-28">{p.birthdate}</span>
                <span className="md:w-8">{p.gender === "M" ? "남" : "여"}</span>
              </div>
              <div className="flex flex-col gap-xxs md:contents">
                <span className="md:w-36">{p.contact ?? ""}</span>
                <span className="truncate md:w-48">{p.email ?? ""}</span>
              </div>
              <span className="flex flex-wrap gap-xs md:ml-auto">
                <Button
                  type="button"
                  variant="tertiary"
                  onClick={() => {
                    setDraft(toDraft(p));
                    setEditing(p.id);
                  }}
                >
                  수정
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
                  onClick={() => void reissue(p)}
                >
                  코드 재발급
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
                  onClick={() => void askDelete(p)}
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
