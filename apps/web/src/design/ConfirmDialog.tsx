import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "./Button";

interface ConfirmDialogProps {
  title: string;
  /** The consequence, spelled out. Kept as a node so counts can be emphasised. */
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A blocking confirmation for actions that cannot be undone. It replaces the
 * inline "I understand" checkbox, which was easy to tick on the way to the
 * button without reading -- a dialog has to be dismissed deliberately.
 *
 * The cancel button takes focus rather than confirm, so a stray Enter closes
 * the dialog instead of destroying data.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-dark/50 px-lg"
    >
      <div className="w-full max-w-[440px] rounded-lg bg-canvas p-xl">
        <h2 className="type-heading-lg text-ink">{title}</h2>
        <div className="type-body-sm mt-md text-body">{body}</div>

        <div className="mt-xl flex justify-end gap-sm">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="type-body-strong rounded-md bg-secondary-bg px-lg py-md text-ink active:bg-secondary-pressed"
          >
            취소
          </button>
          <Button type="button" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
