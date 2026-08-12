import { useCallback, useEffect, useState } from "react";
import type { AdminParticipantRow } from "@shared/types.ts";
import { ApiError, sendCodes } from "../../api/client";
import { Button } from "../../design/Button";
import { ConfirmDialog } from "../../design/ConfirmDialog";

interface AttentionRow {
  displayName: string;
  error: string | null;
}

interface SendStatus {
  enabled: boolean;
  armed: boolean;
  pending: number;
  needsAttention: number;
  needsAttentionSample: AttentionRow[];
}

interface RunSummary {
  outcome:
    | "done"
    | "quota"
    | "time"
    | "partial"
    | "disarmed"
    | "blocked"
    | "sender";
  sent: number;
  failed: number;
  // Populated (non-zero) only for "blocked": how many participants are stuck
  // at the failure ceiling and need a human to edit an address or reissue a
  // code before they become sendable again.
  blocked: number;
}

/**
 * Every outcome except "done" means work is left over, and the admin has to
 * understand what to do about it. Kept as functions (rather than plain
 * strings) because "blocked" has to report a real count, and a Record keyed by
 * every RunSummary["outcome"] means TypeScript refuses to compile if a future
 * outcome is added here without matching copy.
 */
const OUTCOME: Record<RunSummary["outcome"], (summary: RunSummary) => string> = {
  done: () => "전원 발송을 마쳤습니다. 자동 발송은 꺼졌습니다.",
  quota: () =>
    "오늘 메일 한도(300통)에 도달했습니다. 남은 분들은 내일 자동으로 이어서 나갑니다.",
  time: () =>
    "한 번에 처리할 수 있는 시간을 넘겼습니다. 남은 분들은 몇 분 안에 자동으로 이어서 나갑니다.",
  // Someone is still owed a code but is claimed right now -- by this run's
  // own failed send or by a concurrent run. Not an error and not finished;
  // the schedule stays armed and the next tick picks them up on its own.
  partial: () => "남은 분들은 처리가 진행 중입니다. 몇 분 안에 자동으로 이어서 나갑니다.",
  disarmed: () => "자동 발송이 꺼져 있어 아무것도 보내지 않았습니다.",
  // This is the outcome the old "done" bug used to masquerade as: nothing
  // sendable, but only because everyone left was driven out of the queue by
  // repeated failures -- not because they all received mail. Must read as
  // unfinished, name the count, and say what unblocks them.
  blocked: (summary) =>
    `더 보낼 대상이 없습니다. ${summary.blocked}명이 발송 실패가 반복되어 대기열에서 ` +
    `빠졌고, 자동 발송은 꺼졌습니다. 이메일 주소를 확인하고 저장하거나 코드를 재발급해 ` +
    `다시 대상으로 만든 뒤, 자동 발송을 다시 켜주세요.`,
  // Brevo accepts mail from an unvalidated sender and then throws it away, so
  // the run refuses to start rather than report a delivery that never happened.
  sender: () =>
    "발신 주소가 Brevo에 인증되어 있지 않아 한 통도 보내지 않았습니다. " +
    "인증을 마친 뒤 다시 실행해주세요.",
};

/**
 * Looks up OUTCOME defensively rather than indexing it directly. OUTCOME's
 * Record type stays exhaustive over every outcome known TODAY -- that is what
 * makes the compiler refuse a future addition without matching copy, and it
 * must not be weakened. But `summary` itself comes off the network as
 * `RunSummary`, an assertion the compiler cannot verify at runtime: a stale
 * bundle can still receive an outcome value the backend added later, which
 * TypeScript's static exhaustiveness check has no way to see. Indexing
 * OUTCOME directly on that value would then call `undefined` and take the
 * whole panel down with it -- the wrong failure mode for a screen whose job
 * is to say what happened. Casting only at this read site (not on OUTCOME
 * itself) keeps the compile-time guarantee for known outcomes while still
 * degrading gracefully for an unknown one.
 */
function outcomeText(summary: RunSummary): string {
  const lookup = OUTCOME as Record<string, ((s: RunSummary) => string) | undefined>;
  const render = lookup[summary.outcome];
  if (render === undefined) {
    return `처리 결과(${summary.outcome})를 표시할 수 없습니다. 새로고침 후 다시 확인해주세요.`;
  }
  return render(summary);
}

const MESSAGES: Record<string, string> = {
  email_disabled: "이메일 발송이 설정되어 있지 않습니다.",
  unauthorized: "다시 로그인해주세요.",
  network_error: "연결에 실패했습니다. 다시 시도해주세요.",
  server_error: "서버 오류가 발생했습니다.",
};

interface SendPanelProps {
  token: string;
  /**
   * Not read for its contents -- only so a fresh array reference (Admin.tsx
   * hands one out on every reload()) re-triggers the status fetch. Without
   * this, reissuing codes elsewhere in the same tab resets code_sent_at on
   * the server but this panel keeps showing its stale "미발송 0명" and
   * leaves 지금 실행 disabled, so nobody notices those people need a code.
   */
  participants: AdminParticipantRow[];
  onChanged: () => void;
  /**
   * Reports whether email is configured every time status is (re)read, so
   * ParticipantsTab can feed the same value into the per-row 메일 발송
   * button's canSend instead of hardcoding it -- that button can otherwise
   * only ever fail against an unconfigured Brevo.
   */
  onStatus?: (enabled: boolean) => void;
}

export function SendPanel({ token, participants, onChanged, onStatus }: SendPanelProps) {
  const [status, setStatus] = useState<SendStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | undefined>();
  // Arming puts mail in a few hundred inboxes within five minutes and cannot
  // be recalled, so it gets a ConfirmDialog first. Disarming stays a single
  // click -- turning automatic sending off is always safe.
  const [confirmingArm, setConfirmingArm] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await sendCodes<SendStatus>(token, "status");
      setStatus(result);
      onStatus?.(result.enabled);
    } catch {
      // A failed status read hides the panel, which is the safe default; the
      // per-row send button follows suit by being told email is unavailable.
      setStatus(null);
      onStatus?.(false);
    }
  }, [token, onStatus]);

  useEffect(() => {
    void refresh();
    // `participants` is intentionally in the dependency list even though its
    // contents are unused: it is what makes a reissue-codes reload elsewhere
    // in the tab refresh this panel's stale pending count.
  }, [refresh, participants]);

  function report(caught: unknown): void {
    setError(
      caught instanceof ApiError
        ? MESSAGES[caught.code] ?? MESSAGES.server_error
        : MESSAGES.network_error,
    );
  }

  async function disarm(): Promise<void> {
    if (busy || status === null) return;
    setBusy(true);
    setError(undefined);
    try {
      await sendCodes(token, "disarm");
      setSummary(null);
      await refresh();
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  async function confirmArm(): Promise<void> {
    if (busy || status === null) return;
    setBusy(true);
    setError(undefined);
    try {
      await sendCodes(token, "arm");
      setSummary(null);
      setConfirmingArm(false);
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

  if (status === null) return null;

  // Email is off. If it is also disarmed there is nothing this panel can do
  // -- hide it, same as before. But while it is still armed, cron keeps
  // POSTing every five minutes forever with nowhere to send: the only control
  // that can stop that (자동 발송 끄기) must not disappear along with the rest
  // of the panel, or a lost/rotated BREVO_API_KEY mid-campaign becomes
  // unrecoverable from the UI.
  if (!status.enabled) {
    if (!status.armed) return null;
    return (
      <div className="mt-lg rounded-md border border-caution bg-surface-card px-lg py-lg">
        <p className="type-body-sm">
          이메일 발송이 설정되어 있지 않은데 자동 발송은 켜진 상태입니다. cron이
          5분마다 계속 호출되지만 이메일 기능이 꺼져 있어 아무에게도 보내지
          못합니다. 먼저 자동 발송을 꺼주세요.
        </p>
        <div className="mt-md">
          <Button
            type="button"
            variant="tertiary"
            bordered
            loading={busy}
            onClick={() => void disarm()}
          >
            자동 발송 끄기
          </Button>
        </div>
        {error !== undefined && (
          <p role="alert" className="type-body-sm mt-xs text-error">{error}</p>
        )}
      </div>
    );
  }

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
            loading={busy}
            onClick={() => status.armed ? void disarm() : setConfirmingArm(true)}
          >
            {status.armed ? "자동 발송 끄기" : "자동 발송 켜기"}
          </Button>
          <Button
            type="button"
            variant="tertiary"
            bordered
            disabled={!status.armed || status.pending === 0}
            loading={busy}
            onClick={() => void runNow()}
          >
            지금 실행
          </Button>
        </div>
      </div>

      {status.armed && (
        <p className="type-body-sm mt-xs text-mute">
          무장해 두면 남은 분들에게 자동으로 이어서 발송합니다. 하루 한도는 300통이고,
          전원 발송이 끝나면 자동으로 꺼집니다. 각자가 이미 가진 코드를 그대로
          보내므로 코드는 바뀌지 않습니다.
        </p>
      )}

      {summary !== null && (
        <p className="type-body-sm mt-xs">
          {summary.sent}명 발송
          {summary.failed > 0 && `, ${summary.failed}명 실패`}. {outcomeText(summary)}
        </p>
      )}

      {status.needsAttention > 0 && (
        status.armed ? (
          <p className="type-body-sm mt-xs text-mute">
            {status.needsAttention}명은 발송이 반복 실패해 대기열에서 빠졌습니다.
            이메일 주소를 확인하고 저장하거나 코드를 재발급하면 다시 대상이 됩니다.
          </p>
        ) : (
          // Durable, not transient: derived from `status` on every fetch, so
          // it survives a page reload and a run triggered by cron with nobody
          // watching -- unlike the `blocked` summary text above, which only
          // ever renders after the admin presses 지금 실행 themselves. This is
          // the only thing that tells an admin who arrives later that fixing
          // addresses is not enough on its own: automatic sending has to be
          // turned back on, or nothing goes out no matter how many rows get
          // fixed. Bordered and coloured the same way the "email disabled but
          // armed" warning above in this file already is, so it reads as
          // equally urgent rather than blending into the quieter mt-xs lines.
          <div className="mt-md rounded-md border border-caution bg-surface-card px-lg py-md">
            <p className="type-body-sm-strong text-caution">
              {status.needsAttention}명이 발송 실패가 반복되어 대기열에서 빠졌고, 자동
              발송이 꺼져 있습니다.
            </p>
            <p className="type-body-sm mt-xs">
              이메일 주소를 확인하고 저장하거나 코드를 재발급해 다시 대상으로 만든 뒤,
              자동 발송을 다시 켜주세요.
            </p>
          </div>
        )
      )}

      {status.needsAttentionSample.length > 0 && (
        <ul className="type-body-sm mt-xs list-disc pl-lg text-mute">
          {status.needsAttentionSample.map((row, i) => (
            <li key={`${row.displayName}-${i}`}>
              {row.displayName}
              {row.error !== null && ` — ${row.error}`}
            </li>
          ))}
        </ul>
      )}

      {error !== undefined && (
        <p role="alert" className="type-body-sm mt-xs text-error">{error}</p>
      )}

      {confirmingArm && (
        <ConfirmDialog
          title={`${status.pending}명에게 코드를 자동으로 발송합니다`}
          confirmLabel="자동 발송 켜기"
          busy={busy}
          onConfirm={() => void confirmArm()}
          onCancel={() => setConfirmingArm(false)}
          body={
            <>
              <p>
                자동 발송을 켜면 미발송 대상 <strong>{status.pending}명</strong>에게 5분
                안에 메일이 나갑니다. 각자가 지금 가지고 있는 코드를 그대로 보내므로{" "}
                <strong>코드는 바뀌지 않습니다</strong>.
              </p>
              <p className="mt-md">
                하루 발송 한도는 300통이며, 남은 인원은 다음 날 자동으로 이어서
                발송됩니다.
              </p>
              <p className="mt-md text-error">
                메일은 한 번 나가면 되돌릴 수 없습니다.
              </p>
            </>
          }
        />
      )}
    </div>
  );
}
