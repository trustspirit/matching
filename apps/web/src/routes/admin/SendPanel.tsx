import { useCallback, useEffect, useState } from "react";
import { ApiError, sendCodes } from "../../api/client";
import { Button } from "../../design/Button";

interface SendStatus {
  enabled: boolean;
  armed: boolean;
  pending: number;
  needsAttention: number;
}

interface RunSummary {
  outcome: "done" | "quota" | "time" | "partial" | "disarmed";
  sent: number;
  failed: number;
}

/**
 * Every outcome except "done" means work is left over, and the admin has to
 * understand that waiting is correct -- otherwise they keep pressing the
 * button and mint a new code for everyone each time.
 */
const OUTCOME: Record<RunSummary["outcome"], string> = {
  done: "전원 발송을 마쳤습니다. 자동 발송은 꺼졌습니다.",
  quota: "오늘 메일 한도(300통)에 도달했습니다. 남은 분들은 내일 자동으로 이어서 나갑니다.",
  time: "한 번에 처리할 수 있는 시간을 넘겼습니다. 남은 분들은 몇 분 안에 자동으로 이어서 나갑니다.",
  // Someone is still owed a code but is claimed right now -- by this run's
  // own failed send or by a concurrent run. Not an error and not finished;
  // the schedule stays armed and the next tick picks them up on its own.
  partial: "남은 분들은 처리가 진행 중입니다. 몇 분 안에 자동으로 이어서 나갑니다.",
  disarmed: "자동 발송이 꺼져 있어 아무것도 보내지 않았습니다.",
};

const MESSAGES: Record<string, string> = {
  email_disabled: "이메일 발송이 설정되어 있지 않습니다.",
  unauthorized: "다시 로그인해주세요.",
  network_error: "연결에 실패했습니다. 다시 시도해주세요.",
  server_error: "서버 오류가 발생했습니다.",
};

interface SendPanelProps {
  token: string;
  onChanged: () => void;
}

export function SendPanel({ token, onChanged }: SendPanelProps) {
  const [status, setStatus] = useState<SendStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      setStatus(await sendCodes<SendStatus>(token, "status"));
    } catch {
      // A failed status read only hides the panel, which is the safe default.
      setStatus(null);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function report(caught: unknown): void {
    setError(
      caught instanceof ApiError
        ? MESSAGES[caught.code] ?? MESSAGES.server_error
        : MESSAGES.network_error,
    );
  }

  async function toggle(): Promise<void> {
    if (busy || status === null) return;
    setBusy(true);
    setError(undefined);
    try {
      await sendCodes(token, status.armed ? "disarm" : "arm");
      setSummary(null);
      await refresh();
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  async function runNow(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setSummary(await sendCodes<RunSummary>(token, "run"));
      await refresh();
      onChanged();
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  if (status === null || !status.enabled) return null;

  return (
    <div className="mt-lg rounded-md border border-hairline bg-surface-card px-lg py-lg">
      <div className="flex flex-wrap items-center gap-md">
        <p className="type-body-sm">
          미발송 {status.pending}명
          {status.needsAttention > 0 && ` · 확인 필요 ${status.needsAttention}명`}
          {status.armed ? " · 자동 발송 켜짐" : " · 자동 발송 꺼짐"}
        </p>
        <div className="ml-auto flex gap-xs">
          <Button
            type="button"
            variant={status.armed ? "tertiary" : "caution"}
            bordered
            disabled={busy}
            onClick={() => void toggle()}
          >
            {status.armed ? "자동 발송 끄기" : "자동 발송 켜기"}
          </Button>
          <Button
            type="button"
            variant="tertiary"
            bordered
            disabled={busy || !status.armed || status.pending === 0}
            onClick={() => void runNow()}
          >
            지금 실행
          </Button>
        </div>
      </div>

      {status.armed && (
        <p className="type-body-sm mt-xs text-mute">
          무장해 두면 남은 분들에게 자동으로 이어서 발송합니다. 하루 한도는 300통이고,
          전원 발송이 끝나면 자동으로 꺼집니다. 서버는 코드를 해시로만 보관해
          기존 코드를 다시 보낼 수 없으므로 각자에게 새 코드가 발급되어 나갑니다.
        </p>
      )}

      {summary !== null && (
        <p className="type-body-sm mt-xs">
          {summary.sent}명 발송
          {summary.failed > 0 && `, ${summary.failed}명 실패`}. {OUTCOME[summary.outcome]}
        </p>
      )}

      {status.needsAttention > 0 && (
        <p className="type-body-sm mt-xs text-mute">
          {status.needsAttention}명은 발송이 반복 실패해 대기열에서 빠졌습니다.
          이메일 주소를 확인하고 저장하거나 코드를 재발급하면 다시 대상이 됩니다.
        </p>
      )}

      {error !== undefined && (
        <p role="alert" className="type-body-sm mt-xs text-error">{error}</p>
      )}
    </div>
  );
}
