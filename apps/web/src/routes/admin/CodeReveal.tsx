import { Button } from "../../design/Button";

interface CodeRevealProps {
  name: string;
  code: string;
  onDismiss: () => void;
}

/**
 * Shows a freshly issued code. The server stores only its hash, so this is the
 * one and only chance to read it -- hence the deliberately loud framing and
 * the explicit dismiss instead of an auto-hide.
 */
export function CodeReveal({ name, code, onDismiss }: CodeRevealProps) {
  return (
    <div className="mt-lg rounded-md border border-error bg-surface-card px-lg py-lg">
      <p className="type-body-sm text-mute">{name}님의 새 코드</p>
      <p className="type-display-lg mt-xs tracking-widest text-ink">{code}</p>
      <p className="type-body-sm-strong mt-md text-error">
        지금만 볼 수 있습니다. 서버에는 해시만 남아 다시 확인할 수 없습니다.
        참가자에게 전달한 뒤 닫아주세요.
      </p>
      <div className="mt-lg">
        <Button type="button" variant="secondary" onClick={onDismiss}>
          전달했습니다
        </Button>
      </div>
    </div>
  );
}
