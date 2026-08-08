import { useState } from "react";
import type { ImpactRow } from "@shared/types.ts";
import { Button } from "../../design/Button";

interface DeleteParticipantDialogProps {
  name: string;
  birthdate: string;
  impact: ImpactRow[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * matches.male_id / female_id are ON DELETE CASCADE, so removing a participant
 * silently removes their partner's match too. The partner did nothing, so the
 * consequence is spelled out before the operator can confirm.
 */
export function DeleteParticipantDialog({
  name,
  birthdate,
  impact,
  busy,
  onConfirm,
  onCancel,
}: DeleteParticipantDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const partners = impact.map((m) => m.partnerName);

  return (
    <div className="mt-lg rounded-md border border-error bg-surface-card px-lg py-lg">
      <p className="type-body-strong text-ink">
        {name}({birthdate})를 삭제합니다.
      </p>

      {impact.length === 0
        ? (
          <p className="type-body-sm mt-md text-mute">
            이 참가자에게는 등록된 매칭이 없습니다.
          </p>
        )
        : (
          <>
            <p className="type-body-sm mt-md text-error">
              함께 삭제되는 매칭 {impact.length}건:
            </p>
            <ul className="type-body-sm mt-xs list-disc pl-lg text-body">
              {impact.map((m, i) => (
                <li key={`${m.session}-${m.venue}-${m.partnerName}-${i}`}>
                  {m.session} {m.team ?? "조 미정"} — 짝: {m.partnerName}
                </li>
              ))}
            </ul>
            <p className="type-body-sm-strong mt-md text-error">
              {partners.join(", ")}은(는) 짝이 없어집니다.
            </p>
          </>
        )}

      <label className="type-body-sm mt-lg flex items-start gap-sm text-body">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-1"
        />
        <span>알고 있으며 삭제합니다</span>
      </label>

      <div className="mt-lg flex gap-sm">
        <Button
          type="button"
          disabled={!acknowledged}
          loading={busy}
          onClick={onConfirm}
        >
          삭제
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          취소
        </Button>
      </div>
    </div>
  );
}
