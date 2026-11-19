import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Sekvona button system. Same status-pill DNA — soft tinted background +
 * saturated foreground, with subtle inner ring. The brand-gradient `primary`
 * is the only "loud" variant; everything else is calm by design.
 *
 * Variants:
 *   primary     — brand gradient. The single most-important action on the screen.
 *   secondary   — neutral white-tint chip. Default for non-primary actions.
 *   ghost       — transparent until hover. For tertiary or icon-only actions.
 *   accent      — purple soft pill. Use for "launch / open / drive" actions.
 *   success     — emerald soft pill. Use for "running / connected" affordances.
 *   warning     — amber soft pill.
 *   danger      — red soft pill. Use for "wipe / delete / kill".
 *
 * Sizes: sm (h-7), md (h-8 default), lg (h-10).
 */
type Variant =
  | "primary"
  | "secondary"
  | "ghost"
  | "accent"
  | "success"
  | "warning"
  | "danger";
type Size = "sm" | "md" | "lg" | "icon";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
}

/* tint, fg, ring (using rgb for inset shadow) */
const VARIANT_TOKENS: Record<Variant, { bg: string; fg: string; ring: string; hoverBg: string }> = {
  primary: {
    bg: "#b4e2ff",
    fg: "#0c1726",
    ring: "rgba(255, 255, 255, 0.15)",
    hoverBg: "#d8efff",
  },
  secondary: {
    bg: "rgba(255, 255, 255, 0.04)",
    fg: "#cbd5e1",
    ring: "rgba(255, 255, 255, 0.08)",
    hoverBg: "rgba(255, 255, 255, 0.07)",
  },
  ghost: {
    bg: "transparent",
    fg: "#94a3b8",
    ring: "rgba(255, 255, 255, 0.05)",
    hoverBg: "rgba(255, 255, 255, 0.04)",
  },
  accent: {
    bg: "rgba(180, 226, 255, 0.10)",
    fg: "#b4e2ff",
    ring: "rgba(180, 226, 255, 0.20)",
    hoverBg: "rgba(180, 226, 255, 0.16)",
  },
  success: {
    bg: "rgba(16, 185, 129, 0.10)",
    fg: "#34d399",
    ring: "rgba(16, 185, 129, 0.22)",
    hoverBg: "rgba(16, 185, 129, 0.16)",
  },
  warning: {
    bg: "rgba(245, 158, 11, 0.10)",
    fg: "#fbbf24",
    ring: "rgba(245, 158, 11, 0.22)",
    hoverBg: "rgba(245, 158, 11, 0.16)",
  },
  danger: {
    bg: "rgba(239, 68, 68, 0.08)",
    fg: "#fca5a5",
    ring: "rgba(239, 68, 68, 0.25)",
    hoverBg: "rgba(239, 68, 68, 0.14)",
  },
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[11px] gap-1.5 rounded-md",
  md: "h-8 px-3 text-[12px] gap-1.5 rounded-md",
  lg: "h-10 px-4 text-[13px] gap-2 rounded-[10px]",
  icon: "h-8 w-8 rounded-md",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = "secondary",
    size = "md",
    leftIcon,
    rightIcon,
    fullWidth,
    className,
    children,
    style,
    ...rest
  },
  ref,
) {
  const t = VARIANT_TOKENS[variant];
  const isPrimary = variant === "primary";
  return (
    <button
      ref={ref}
      type="button"
      data-variant={variant}
      className={cn(
        "mz-button inline-flex items-center justify-center font-medium",
        "transition-all duration-150",
        "disabled:opacity-50 disabled:pointer-events-none",
        SIZE_CLASSES[size],
        fullWidth && "w-full",
        className,
      )}
      style={{
        background: t.bg,
        color: t.fg,
        boxShadow: isPrimary
          ? `inset 0 0 0 1px ${t.ring}, 0 6px 20px -6px rgba(180, 226, 255, 0.45)`
          : `inset 0 0 0 1px ${t.ring}`,
        ...style,
      }}
      {...rest}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});
