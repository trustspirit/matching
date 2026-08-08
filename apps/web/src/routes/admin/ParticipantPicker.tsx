import { useState } from "react";
import type { AdminParticipantRow } from "@shared/types.ts";
import { searchParticipants } from "../../lib/participantSearch";

interface ParticipantPickerProps {
  label: string;
  gender: "M" | "F";
  participants: AdminParticipantRow[];
  valueId: string;
  onSelect: (id: string) => void;
}

export function ParticipantPicker({
  label,
  gender,
  participants,
  valueId,
  onSelect,
}: ParticipantPickerProps) {
  const selected = participants.find((p) => p.id === valueId);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const suggestions = searchParticipants(participants, gender, query);

  return (
    <div className="relative flex flex-col gap-xs">
      <span className="type-caption-md text-mute">{label}</span>
      <input
        value={open ? query : selected?.displayName ?? ""}
        placeholder="이름 검색"
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onBlur={() => {
          // Delayed so a click on a suggestion registers before the list closes.
          window.setTimeout(() => setOpen(false), 150);
        }}
        onChange={(event) => setQuery(event.target.value)}
        className="type-body-md h-11 rounded-md border border-ash bg-canvas px-md text-ink"
      />
      {selected !== undefined && !open && (
        <span className="type-caption-md text-ash">{selected.birthdate}</span>
      )}

      {open && suggestions.length > 0 && (
        <ul className="absolute top-full z-10 mt-xxs w-full rounded-md border border-hairline bg-canvas">
          {suggestions.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onMouseDown={() => {
                  onSelect(p.id);
                  setOpen(false);
                }}
                className="type-body-sm flex w-full justify-between px-md py-sm text-left text-ink active:bg-surface-card"
              >
                <span>{p.displayName}</span>
                {/* The source data has people who share a name, so the
                    birthdate is what actually identifies the person. */}
                <span className="text-ash">{p.birthdate}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
