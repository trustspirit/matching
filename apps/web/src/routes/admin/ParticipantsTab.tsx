import { useState } from "react";
import type { AdminParticipantRow, ImpactRow } from "@shared/types.ts";
import { adminData, ApiError } from "../../api/client";
import { Button, ROW_BUTTON } from "../../design/Button";
import { Card } from "../../design/Card";
import { ConfirmDialog } from "../../design/ConfirmDialog";
import { SearchInput } from "../../design/SearchInput";
import { Select } from "../../design/Select";
import { nameMatches } from "../../lib/nameFilter";
import { CodeReveal } from "./CodeReveal";
import { DeleteParticipantDialog } from "./DeleteParticipantDialog";
import { SendPanel } from "./SendPanel";

const MESSAGES: Record<string, string> = {
  invalid_request: "입력값을 확인해주세요.",
  no_email: "이 참가자에게는 등록된 이메일이 없습니다.",
  email_disabled: "이메일 발송이 설정되어 있지 않습니다.",
  email_failed: "메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.",
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
  id: string;
  name: string;
  code: string;
  email: string | null;
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // null = no dialog, otherwise the ids to reissue (empty array means everyone).
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [issuedCsv, setIssuedCsv] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<string | undefined>();
  const [nameQuery, setNameQuery] = useState("");
  // SendPanel already asks send-codes whether Brevo is configured; lifted here
  // so the per-row 메일 발송 button can be honest instead of always assuming
  // it will work. Defaults to false so the button stays hidden until the
  // first status read lands, same fail-closed default SendPanel itself uses.
  const [emailEnabled, setEmailEnabled] = useState(false);

  const visible = participants.filter((p) =>
    nameMatches(nameQuery, p.displayName)
  );

  async function sendCode(): Promise<void> {
    if (revealed === null || sending) return;
    setSending(true);
    setSendError(undefined);
    try {
      await adminData(token, "send_code", {
        id: revealed.id,
        code: revealed.code,
      });
      setSent(true);
    } catch (caught) {
      setSendError(
        caught instanceof ApiError
          ? MESSAGES[caught.code] ?? MESSAGES.server_error
          : MESSAGES.network_error,
      );
    } finally {
      setSending(false);
    }
  }

  const allSelected = visible.length > 0 &&
    visible.every((p) => selected.has(p.id));

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function downloadCodes(csv: string): void {
    // Excel needs a BOM to read UTF-8 Korean without mojibake.
    const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "참가자_코드.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function reissueMany(ids: string[]): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await adminData<{ count: number; codesCsv: string }>(
        token,
        "regenerate_codes",
        // An empty list means "everyone"; the server rejects an explicit [].
        ids.length === 0 ? {} : { ids },
      );
      setConfirming(null);
      setSelected(new Set());
      setIssuedCsv(result.codesCsv);
      downloadCodes(result.codesCsv);
      onChanged();
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

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
        setSent(false);
        setSendError(undefined);
        setRevealed({
          id: created.id,
          name: draft.displayName,
          code: created.code,
          email: draft.email.trim() === "" ? null : draft.email.trim(),
        });
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
      setSent(false);
      setSendError(undefined);
      setRevealed({
        id: row.id,
        name: row.displayName,
        code: result.code,
        email: row.email,
      });
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
      <div className="flex flex-wrap items-center gap-md">
        <label className="type-body-sm flex items-center gap-xs text-body">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) =>
              // Scoped to the rows on screen. Ticking a box while a search is
              // active and silently selecting people the operator cannot see
              // would make the reissue count a surprise.
              setSelected(
                e.target.checked ? new Set(visible.map((p) => p.id)) : new Set(),
              )}
          />
          <span>전체 선택</span>
        </label>

        <SearchInput
          label="이름"
          value={nameQuery}
          onValueChange={setNameQuery}
          placeholder="김철수"
          className="w-40"
        />

        <p className="type-body-md text-mute">
          {selected.size > 0
            ? `${selected.size}명 선택 / ${participants.length}명`
            : visible.length === participants.length
            ? `참가자 ${participants.length}명`
            : `참가자 ${visible.length} / ${participants.length}명`}
        </p>

        <div className="ml-auto flex flex-wrap gap-xs">
          <Button
            type="button"
            variant="tertiary"
            bordered
            disabled={selected.size === 0}
            onClick={() => setConfirming([...selected])}
          >
            선택 {selected.size}명 코드 재발급
          </Button>
          <Button
            type="button"
            variant="tertiary"
            bordered
            disabled={participants.length === 0}
            onClick={() => setConfirming([])}
          >
            전원 코드 재발급
          </Button>
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
      </div>

      <SendPanel token={token} onChanged={onChanged} onStatus={setEmailEnabled} />

      {confirming !== null && (
        <ConfirmDialog
          title={confirming.length === 0
            ? "전원 코드를 재발급합니다"
            : `${confirming.length}명의 코드를 재발급합니다`}
          confirmLabel="재발급"
          busy={busy}
          onConfirm={() => void reissueMany(confirming)}
          onCancel={() => setConfirming(null)}
          body={
            <>
              <p>
                {confirming.length === 0
                  ? `참가자 ${participants.length}명 전원`
                  : `선택한 ${confirming.length}명`}
                의 코드가 새로 발급되고,{" "}
                <strong>이미 나눠준 코드는 즉시 무효</strong>가 됩니다.
              </p>
              <p className="mt-md text-error">
                새 코드는 발급 직후 내려받는 CSV에만 있습니다. 서버에는 해시만
                남아 다시 확인할 수 없습니다.
              </p>
            </>
          }
        />
      )}

      {issuedCsv !== null && (
        <div className="mt-lg rounded-md border border-error bg-surface-card px-lg py-lg">
          <p className="type-body-sm-strong text-error">
            코드 CSV가 내려받아졌습니다. 평문 코드는 그 파일에만 있습니다.
          </p>
          <div className="mt-md flex flex-wrap gap-sm">
            <Button
              type="button"
              variant="secondary"
              onClick={() => downloadCodes(issuedCsv)}
            >
              다시 받기
            </Button>
            <Button
              type="button"
              variant="tertiary"
              onClick={() => setIssuedCsv(null)}
            >
              닫기
            </Button>
          </div>
        </div>
      )}

      {error !== undefined && (
        <p role="alert" className="type-body-sm mt-md text-error">{error}</p>
      )}

      {revealed !== null && (
        <CodeReveal
          name={revealed.name}
          code={revealed.code}
          email={revealed.email}
          canSend={emailEnabled}
          sending={sending}
          sent={sent}
          sendError={sendError}
          onSend={() => void sendCode()}
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
        {visible.map((p) =>
          editing === p.id ? editor(p.id) : (
            // Stacked card on a phone, single table row from md up.
            // `md:contents` dissolves the grouping wrappers at md so their
            // children become columns of one row without duplicated markup.
            <div
              key={p.id}
              // No wrapping from md up: the columns and the action group have
              // to stay on one line, or the buttons drop to a second row and
              // stop lining up with the record they act on.
              className="type-body-sm flex flex-col gap-xs border-t border-hairline py-md text-body md:flex-row md:flex-nowrap md:items-center md:gap-md"
            >
              <div className="flex items-center gap-md md:contents">
                <input
                  type="checkbox"
                  aria-label={`${p.displayName} 선택`}
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                />
                <span className="type-body-sm-strong text-ink md:w-24 md:font-normal">
                  {p.displayName}
                </span>
                <span className="md:w-28">{p.birthdate}</span>
                <span className="md:w-8">{p.gender === "M" ? "남" : "여"}</span>
              </div>
              <div className="flex flex-col gap-xxs md:contents">
                {/* Dropped between md and lg. Everything else in the row is
                    either identity or the thing codes get sent to, and one
                    column had to go for the buttons to fit on one line. */}
                <span className="md:hidden lg:inline lg:w-36">
                  {p.contact ?? ""}
                </span>
                {/* Takes the leftover width so a long address shortens itself
                    instead of pushing the buttons off the line. */}
                <span className="flex min-w-0 items-center gap-xs md:flex-1">
                  <span className="truncate">{p.email ?? ""}</span>
                  {p.email !== null && p.email !== "" &&
                    p.codeSentAt === null && (
                    <span className="type-caption-md shrink-0 rounded-sm bg-secondary-bg px-xs py-xxs text-caution">
                      미발송
                    </span>
                  )}
                </span>
              </div>
              <span className="flex flex-wrap gap-xs md:ml-auto md:flex-nowrap md:gap-0">
                <Button
                  type="button"
                  variant="tertiary"
                  className={ROW_BUTTON}
                  onClick={() => {
                    setDraft(toDraft(p));
                    setEditing(p.id);
                  }}
                >
                  수정
                </Button>
                <Button
                  type="button"
                  variant="caution"
                  className={ROW_BUTTON}
                  onClick={() => void reissue(p)}
                >
                  코드 재발급
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  className={ROW_BUTTON}
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
