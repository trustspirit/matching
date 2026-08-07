import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "tertiary";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
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
};

export function Button({
  variant = "primary",
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
        "type-button-md rounded-md px-[14px] transition-colors",
        // 48px rather than the spec's 40px: this is a phone-first page and
        // WCAG AA wants at least 44px of tappable height.
        "h-12",
        fullWidth ? "w-full" : "",
        VARIANT_CLASS[variant],
        "disabled:cursor-not-allowed",
        className,
      ].join(" ")}
    >
      {loading ? loadingText : children}
    </button>
  );
}
