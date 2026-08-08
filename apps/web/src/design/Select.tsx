import { type ReactNode, type SelectHTMLAttributes, useId } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  children: ReactNode;
}

/**
 * Matches TextInput's height, radius and border so a select sitting next to one
 * does not read as a different control. The native arrow is suppressed with
 * appearance-none and redrawn here, because the platform glyph ignores the
 * design system's colour and sits at an inconsistent inset across browsers.
 */
export function Select(
  { label, children, className = "", ...rest }: SelectProps,
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
            "type-body-md h-11 w-full appearance-none rounded-md bg-canvas",
            // pr-10 leaves room for the arrow so a long option never runs
            // underneath it.
            "border border-ash pl-md pr-10 text-ink",
            className,
          ].join(" ")}
        >
          {children}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="pointer-events-none absolute right-md top-1/2 h-4 w-4 -translate-y-1/2 fill-none stroke-mute"
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
