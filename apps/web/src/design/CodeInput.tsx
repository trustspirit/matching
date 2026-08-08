import { useId, useRef, useState } from "react";
import { CODE_LENGTH } from "@shared/code.ts";
import { acceptChar, distributePaste, nextFocusIndex } from "../lib/codeInput";

interface CodeInputProps {
  label: string;
  /** Receives the entered characters joined together, e.g. "K7M2QX". */
  onChange: (next: string) => void;
  error?: string;
}

const EMPTY_CELLS: string[] = Array.from({ length: CODE_LENGTH }, () => "");

export function CodeInput({ label, onChange, error }: CodeInputProps) {
  const groupId = useId();
  const errorId = `${groupId}-error`;
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  // Owned here, not derived from a string prop. A joined string cannot express
  // "cell 2 is empty while cell 3 holds a character", so round-tripping through
  // the parent would shift characters leftward after erasing a middle cell.
  const [cells, setCells] = useState<string[]>(EMPTY_CELLS);

  function focusCell(index: number): void {
    refs.current[index]?.focus();
    refs.current[index]?.select();
  }

  function commit(next: string[], focusIndex: number): void {
    setCells(next);
    onChange(next.join(""));
    focusCell(focusIndex);
  }

  return (
    <div className="flex flex-col gap-xs">
      <span id={groupId} className="type-body-strong text-ink">
        {label}
      </span>

      <div
        role="group"
        aria-labelledby={groupId}
        aria-describedby={error === undefined ? undefined : errorId}
        className="flex gap-sm"
      >
        {cells.map((cell, index) => (
          <input
            key={index}
            ref={(el) => {
              refs.current[index] = el;
            }}
            value={cell}
            aria-label={`코드 ${index + 1}번째 자리`}
            aria-invalid={error !== undefined}
            inputMode="text"
            autoCapitalize="characters"
            // Deliberately not "one-time-code": iOS mistakes it for an SMS
            // verification code and offers unrelated autofill.
            autoComplete="off"
            spellCheck={false}
            maxLength={1}
            onChange={(event) => {
              const ch = acceptChar(event.target.value.slice(-1));
              if (ch === null) return;
              const next = [...cells];
              next[index] = ch;
              commit(next, nextFocusIndex(index, "type", true));
            }}
            onKeyDown={(event) => {
              if (event.key === "Backspace") {
                event.preventDefault();
                const wasEmpty = cells[index] === "";
                const next = [...cells];
                next[wasEmpty ? Math.max(index - 1, 0) : index] = "";
                commit(next, nextFocusIndex(index, "erase", wasEmpty));
                return;
              }
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                focusCell(Math.max(index - 1, 0));
                return;
              }
              if (event.key === "ArrowRight") {
                event.preventDefault();
                focusCell(Math.min(index + 1, CODE_LENGTH - 1));
              }
            }}
            onPaste={(event) => {
              event.preventDefault();
              const pasted = event.clipboardData.getData("text");
              const next = distributePaste(pasted, index, cells);
              // Land on the first still-empty cell, or the last cell if the
              // paste filled everything. Counting filled cells would be wrong
              // when the paste leaves a gap behind it.
              const firstEmpty = next.indexOf("");
              commit(next, firstEmpty === -1 ? CODE_LENGTH - 1 : firstEmpty);
            }}
            className={[
              "type-heading-lg h-14 min-w-0 flex-1 rounded-md bg-canvas",
              "border text-center uppercase text-ink",
              error === undefined ? "border-ash" : "border-error",
            ].join(" ")}
          />
        ))}
      </div>

      {error !== undefined && (
        <p id={errorId} role="alert" className="type-body-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}
