interface SkeletonRowsProps {
  rows?: number;
  /**
   * One Tailwind width class per column, so the placeholder lines up with the
   * table it stands in for instead of collapsing into a block of equal bars.
   */
  widths?: string[];
}

/**
 * Placeholder for a table that has not arrived yet. Rendered only for the first
 * load: once there are rows on screen, a refresh leaves them in place and says
 * so quietly elsewhere, because swapping a populated table for grey bars reads
 * as the data having been lost.
 */
export function SkeletonRows({
  rows = 6,
  widths = ["w-14", "w-28", "w-20", "w-28", "w-28"],
}: SkeletonRowsProps) {
  return (
    <div aria-busy="true" className="flex flex-col">
      {/* The bars carry no text, so the only thing a screen reader can
          announce is this. */}
      <span className="sr-only">불러오는 중…</span>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="flex flex-wrap items-center gap-md border-t border-hairline py-md"
        >
          {widths.map((width, column) => (
            <span
              key={column}
              className={`h-4 ${width} animate-pulse rounded-sm bg-secondary-bg`}
              // Staggered so the row reads as one object settling in rather
              // than five bars blinking in lockstep.
              style={{ animationDelay: `${(row + column) * 80}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
