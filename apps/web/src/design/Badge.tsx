import type { ReactNode } from "react";

/* filter-chip-active: fully inverted pill. Used for the session label so the
   result screen needs no red at all. */
export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="type-button-md inline-block rounded-full bg-ink px-lg py-sm text-on-primary">
      {children}
    </span>
  );
}
