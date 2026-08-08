import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "tertiary" | "caution" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /**
   * Draws an outline in the variant's own colour.
   *
   * The unfilled variants carry their meaning entirely in the label colour,
   * which works inside a dense table row where everything around them is data.
   * Standing alone in a toolbar they stop reading as controls at all, and an
   * outline is what puts the edge back without adding a competing fill.
   */
  bordered?: boolean;
  fullWidth?: boolean;
  loading?: boolean;
  /** Text shown in place of children while loading. Defaults to the login flow's copy. */
  loadingText?: string;
  children: ReactNode;
}

/* Radius is always 16px: the system has no sharp-cornered interactive elements. */
const VARIANT_CLASS: Record<Variant, string> = {
  primary:
    "bg-primary text-on-primary active:bg-primary-pressed disabled:bg-surface-card disabled:text-ash",
  secondary:
    "bg-secondary-bg text-ink active:bg-secondary-pressed disabled:bg-surface-card disabled:text-ash",
  tertiary: "bg-transparent text-ink active:bg-surface-card",
  // Both carry their weight in the label colour rather than a fill: a row of
  // filled red buttons would shout louder than the data it sits next to.
  caution: "bg-transparent text-caution active:bg-surface-card",
  danger: "bg-transparent text-error active:bg-surface-card",
};

const BORDER_CLASS: Record<Variant, string> = {
  primary: "border-primary",
  secondary: "border-stone",
  // Not border-ink: a black outline on a neutral action outweighs the coloured
  // outlines beside it and turns the least important button into the loudest.
  tertiary: "border-ash",
  caution: "border-caution",
  danger: "border-error",
};

/**
 * Sizing for a button that sits inside a table row.
 *
 * The 48px default exists so a thumb can hit it, which still applies while the
 * row is a stacked card on a phone. From md the row is a real table driven by
 * a pointer, and three 48px buttons per row both tower over the text they act
 * on and eat the width the columns need.
 */
export const ROW_BUTTON = "md:h-9 md:px-md";

export function Button({
  variant = "primary",
  bordered = false,
  fullWidth = false,
  loading = false,
  loadingText = "확인 중…",
  disabled,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={[
        // px-lg (16px), not the source spec's 14px: Button's height is already
        // 48px instead of the spec's 40px for touch-target reasons, so there's
        // no exact-height pairing left to preserve, and snapping to the token
        // scale keeps this consistent with TextInput's own padding below.
        "type-button-md rounded-md px-lg transition-colors",
        // 48px rather than the spec's 40px: this is a phone-first page and
        // WCAG AA wants at least 44px of tappable height.
        "h-12",
        fullWidth ? "w-full" : "",
        VARIANT_CLASS[variant],
        bordered ? `border ${BORDER_CLASS[variant]}` : "",
        "disabled:cursor-not-allowed",
        className,
      ].join(" ")}
    >
      {loading ? loadingText : children}
    </button>
  );
}
