import { type ReactNode, type SelectHTMLAttributes, useId } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  /**
   * Filter controls sit in a row of their own with no text inputs beside them,
   * where the form-sized control reads as too heavy. Form fields keep the
   * default so they line up with TextInput.
   */
  compact?: boolean;
  children: ReactNode;
}

/**
 * Matches TextInput's height, radius and border so a select sitting next to one
 * does not read as a different control. The native arrow is suppressed with
 * appearance-none and redrawn here, because the platform glyph ignores the
 * design system's colour and sits at an inconsistent inset across browsers.
 */
export function Select(
  { label, compact = false, children, className = "", ...rest }: SelectProps,
) {
  const id = useId();
  return (
    <div className="flex flex-col gap-xs">
      <label htmlFor={id} className="type-caption-md text-mute">
        {label}
      </label>
      <div className="relative">
        <select
          {...rest}
          id={id}
          className={[
            "w-full appearance-none rounded-md bg-canvas border border-ash text-ink",
            // The right padding leaves room for the arrow so a long option
            // never runs underneath it.
            compact
              ? "type-body-sm h-9 pl-sm pr-8"
              : "type-body-md h-11 pl-md pr-10",
            className,
          ].join(" ")}
        >
          {children}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className={[
            "pointer-events-none absolute top-1/2 -translate-y-1/2 fill-none stroke-mute",
            compact ? "right-sm h-3 w-3" : "right-md h-4 w-4",
          ].join(" ")}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 8l4 4 4-4" />
        </svg>
      </div>
    </div>
  );
}
