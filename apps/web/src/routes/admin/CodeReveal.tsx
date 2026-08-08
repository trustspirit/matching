import { Button } from "../../design/Button";

interface CodeRevealProps {
  name: string;
  code: string;
  /** Absent when the participant has no address on file. */
  email: string | null;
  /** False when the mail provider is not configured on the server. */
  canSend: boolean;
  sending: boolean;
  sent: boolean;
  sendError?: string;
  onSend: () => void;
  onDismiss: () => void;
}

/**
 * Shows a freshly issued code. The server stores only its hash, so this is the
 * one and only chance to read it -- hence the deliberately loud framing and
 * the explicit dismiss instead of an auto-hide.
 */
export function CodeReveal({
  name,
  code,
  email,
  canSend,
  sending,
  sent,
  sendError,
  onSend,
  onDismiss,
}: CodeRevealProps) {
  return (
    <div className="mt-lg rounded-md border border-error bg-surface-card px-lg py-lg">
      <p className="type-body-sm text-mute">{name}님의 새 코드</p>
      <p className="type-display-lg mt-xs tracking-widest text-ink">{code}</p>
      <p className="type-body-sm-strong mt-md text-error">
        지금만 볼 수 있습니다. 서버에는 해시만 남아 다시 확인할 수 없습니다.
        참가자에게 전달한 뒤 닫아주세요.
      </p>
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
          전달했습니다
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
