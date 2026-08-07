import { forwardRef, type InputHTMLAttributes, useId } from "react";

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput({ label, error, className = "", ...rest }, ref) {
    const id = useId();
    const errorId = `${id}-error`;
    return (
      <div className="flex flex-col gap-xs">
        <label htmlFor={id} className="type-body-strong text-ink">
          {label}
        </label>
        <input
          {...rest}
          id={id}
          ref={ref}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          className={[
            // px-lg (16px), not the source spec's 15px -- same token-scale reasoning as Button.
            "type-body-md h-11 rounded-md bg-canvas px-lg text-ink",
            "border placeholder:text-ash",
            error === undefined ? "border-ash" : "border-error",
            className,
          ].join(" ")}
        />
        {error !== undefined && (
          <p id={errorId} role="alert" className="type-body-sm text-error">
            {error}
          </p>
        )}
      </div>
    );
  },
);
