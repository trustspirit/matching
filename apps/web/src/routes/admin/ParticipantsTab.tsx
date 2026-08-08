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
          // Stacked card on a phone, single table row from md up. `md:contents`
          // dissolves the grouping wrappers at md so their children become
          // columns of one row without duplicating the markup.
          <div
            key={p.id}
            className="type-body-sm flex flex-col gap-xs border-t border-hairline py-md text-body md:flex-row md:flex-wrap md:items-center md:gap-md"
          >
            <div className="flex gap-md md:contents">
              <span className="type-body-sm-strong text-ink md:w-24 md:font-normal">
                {p.displayName}
              </span>
              <span className="md:w-28">{p.birthdate}</span>
              <span className="md:w-8">{p.gender === "M" ? "남" : "여"}</span>
            </div>
            <div className="flex flex-col gap-xxs md:contents">
              <span className="md:w-36">{p.contact ?? ""}</span>
              <span className="truncate md:flex-1">{p.email ?? ""}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
