import { useEffect, useState } from "react";
import { formatKst, isoToKstLocal } from "@shared/revealTime.ts";
import type { Session } from "@shared/types.ts";
import { adminData, ApiError } from "../../api/client";
import { Button } from "../../design/Button";

const SESSIONS: Session[] = ["1부", "2부"];

const MESSAGES: Record<string, string> = {
  invalid_request: "시간을 다시 확인해주세요.",
  unauthorized: "다시 로그인해주세요.",
  network_error: "연결에 실패했습니다. 다시 시도해주세요.",
  server_error: "서버 오류가 발생했습니다.",
};

type RevealTimes = Record<Session, string | null>;

/**
 * The moment each session's partner information stops being withheld.
 *
 * Editable rather than fixed at deploy time because the one night this matters
 * is also the night nobody can deploy: if 1부 starts twenty minutes late, the
 * organiser moves the time here and the participants' screens follow.
 *
 * Every value on the wire is an instant with an offset; the inputs below are
 * Seoul wall-clock. isoToKstLocal and the server's kstLocalToIso are the two
 * ends of that conversion, so a laptop set to another timezone still schedules
 * 9:50pm in Seoul.
 */
export function RevealPanel({ token }: { token: string }) {
  const [saved, setSaved] = useState<RevealTimes | null>(null);
  const [draft, setDraft] = useState<Record<Session, string>>({
    "1부": "",
    "2부": "",
  });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const body = await adminData<{ revealAt: RevealTimes }>(
          token,
          "get_reveal_times",
        );
        if (!live) return;
        setSaved(body.revealAt);
        setDraft({
          "1부": body.revealAt["1부"] === null
            ? ""
            : isoToKstLocal(body.revealAt["1부"]),
          "2부": body.revealAt["2부"] === null
            ? ""
            : isoToKstLocal(body.revealAt["2부"]),
        });
      } catch {
        // A failed read leaves the panel closed rather than showing a
        // half-filled form; the matches table around it still works.
      }
    })();
    return () => {
      live = false;
    };
  }, [token]);

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const body = await adminData<{ revealAt: RevealTimes }>(
        token,
        "set_reveal_times",
        { revealAt: draft },
      );
      setSaved(body.revealAt);
      setOpen(false);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? MESSAGES[caught.code] ?? MESSAGES.server_error
          : MESSAGES.network_error,
      );
    } finally {
      setBusy(false);
    }
  }

  if (saved === null) return null;

  return (
    <div className="mt-lg rounded-md border border-hairline bg-surface-card px-lg py-lg">
      <div className="flex flex-wrap items-center gap-md">
        <p className="type-body-sm">
          상대 공개 ·{" "}
          {SESSIONS.map((s) =>
            `${s} ${saved[s] === null ? "미설정" : formatKst(saved[s])}`
          ).join(" · ")}
        </p>
        <div className="ml-auto">
          <Button
            type="button"
            variant="tertiary"
            bordered
            onClick={() => setOpen(!open)}
          >
            {open ? "닫기" : "시간 변경"}
          </Button>
        </div>
      </div>

      <p className="type-caption-md mt-xs text-mute">
        이 시각 전에는 참가자 화면에서 상대 이름과 조가 가려집니다. 서버가 아예
        보내지 않습니다.
      </p>

      {open && (
        <div className="mt-md flex flex-col gap-md md:flex-row md:items-end">
          {SESSIONS.map((session) => (
            <label key={session} className="flex flex-col gap-xs">
              <span className="type-caption-md text-mute">
                {session} 공개 (한국시간)
              </span>
              <input
                type="datetime-local"
                value={draft[session]}
                onChange={(e) =>
                  setDraft({ ...draft, [session]: e.target.value })}
                className="type-body-md h-11 w-full rounded-md border border-ash bg-canvas px-md text-ink md:w-56"
              />
            </label>
          ))}
          <Button type="button" loading={busy} onClick={() => void save()}>
            저장
          </Button>
        </div>
      )}

      {error !== undefined && (
        <p role="alert" className="type-body-sm mt-md text-error">{error}</p>
      )}
    </div>
  );
}
