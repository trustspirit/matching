import { Button } from "../../design/Button";

interface CodeRevealProps {
  name: string;
  code: string;
  /** Absent when the participant has no address on file. */
  email: string | null;
  /** False when the mail provider is not configured on the server. */
  canSend: boolean;
  /**
   * True when this code was just minted. The code itself reads the same either
   * way; what differs is that a fresh one has already invalidated whatever the
   * participant was holding, which is worth saying out loud.
   */
  justIssued: boolean;
  sending: boolean;
  sent: boolean;
  sendError?: string;
  onSend: () => void;
  onDismiss: () => void;
}

/**
 * Shows one participant's code.
 *
 * This used to be the single chance to read a freshly minted code, because the
 * server kept only its digest. Codes are stored as themselves now, so the
 * panel is no longer a point of no return -- it can be reopened from the row
 * at any time, and the urgency is reserved for a reissue, which does still
 * invalidate the code already in the participant's hands.
 */
export function CodeReveal({
  name,
  code,
  email,
  canSend,
  justIssued,
  sending,
  sent,
  sendError,
  onSend,
  onDismiss,
}: CodeRevealProps) {
  return (
    <div
      className={`mt-lg rounded-md border bg-surface-card px-lg py-lg ${
        justIssued ? "border-caution" : "border-hairline"
      }`}
    >
      <p className="type-body-sm text-mute">
        {name}님의 {justIssued ? "새 " : ""}코드
      </p>
      <p className="type-display-lg mt-xs tracking-widest text-ink">{code}</p>
      {justIssued && (
        <p className="type-body-sm-strong mt-md text-caution">
          이 참가자가 이전에 받은 코드는 방금 무효가 되었습니다. 새 코드를
          전달해주세요.
        </p>
      )}
      {sendError !== undefined && (
        <p role="alert" className="type-body-sm mt-md text-error">{sendError}</p>
      )}
      {sent && (
        <p className="type-body-sm mt-md text-body">
          {email}로 보냈습니다.
        </p>
      )}

      <div className="mt-lg flex flex-wrap gap-sm">
        {/* Only offered when it can actually work: no address on file, or no
            provider configured, means the button would only ever fail. */}
        {canSend && email !== null && !sent && (
          <Button type="button" loading={sending} onClick={onSend}>
            이메일로 보내기
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onDismiss}>
          닫기
        </Button>
      </div>

      {canSend && email === null && (
        <p className="type-caption-md mt-md text-ash">
          이 참가자에게는 등록된 이메일이 없어 직접 전달해야 합니다.
        </p>
      )}
    </div>
  );
}
