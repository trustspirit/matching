import type { AdminParticipantRow } from "@shared/types.ts";
import { Card } from "../../design/Card";

interface ParticipantsTabProps {
  participants: AdminParticipantRow[];
}

export function ParticipantsTab({ participants }: ParticipantsTabProps) {
  return (
    <Card>
      <p className="type-body-md text-mute">참가자 {participants.length}명</p>
      <p className="type-caption-md mt-xs text-ash">
        편집과 코드 재발급은 다음 단계에서 추가됩니다.
      </p>

      <div className="mt-lg flex flex-col">
        {participants.map((p) => (
          <div
            key={p.id}
            className="type-body-sm flex flex-wrap items-center gap-md border-t border-hairline py-md text-body"
          >
            <span className="w-24 text-ink">{p.displayName}</span>
            <span className="w-28">{p.birthdate}</span>
            <span className="w-8">{p.gender === "M" ? "남" : "여"}</span>
            <span className="w-36">{p.contact ?? ""}</span>
            <span className="flex-1 truncate">{p.email ?? ""}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
