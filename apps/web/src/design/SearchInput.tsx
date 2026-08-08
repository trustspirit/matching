import { type InputHTMLAttributes, useId } from "react";

interface SearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
}

/**
 * Filter-row search box. Deliberately built to Select's compact metrics -- same
 * height, radius, border and label -- because it sits directly beside the
 * filter selects and any difference reads as a different kind of control.
 *
 * `type="search"` rather than `text` so a phone keyboard offers the search key
 * and Escape clears the field natively; the button below is for pointer users,
 * who have no such shortcut.
 */
export function SearchInput(
  { label, value, onValueChange, className = "", ...rest }: SearchInputProps,
) {
  const id = useId();
  return (
    <div className="flex flex-col gap-xs">
      <label htmlFor={id} className="type-caption-md text-mute">
        {label}
      </label>
      <div className="relative">
        <input
          {...rest}
          id={id}
          type="search"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className={[
            "type-body-sm h-9 w-full rounded-md border border-ash bg-canvas pl-sm text-ink",
            // Room for the clear button so a long query never runs under it.
            "pr-8",
            // Safari draws its own clear affordance on type=search, which would
            // sit on top of ours.
            "[&::-webkit-search-cancel-button]:appearance-none",
            className,
          ].join(" ")}
        />
        {value !== "" && (
          <button
            type="button"
            aria-label="검색어 지우기"
            onClick={() => onValueChange("")}
            className="absolute right-0 top-0 flex h-9 w-8 items-center justify-center text-mute"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="h-3 w-3 fill-none stroke-current"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
