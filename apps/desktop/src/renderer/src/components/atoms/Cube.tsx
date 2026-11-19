import type { JSX } from "react";
// Import as URL so Vite/electron-vite rewrite the path correctly in
// production builds. Hardcoding "/logo.png" worked in dev (Vite's dev
// server serves public/ at /) but 404'd in the packaged Electron
// app — the renderer loads via file://, and / there resolves to the
// filesystem root.
import logoUrl from "/brand-mark.svg?url";

interface Props {
  size?: number;
  glow?: boolean;
  className?: string;
}

/**
 * Brand mark — Sekvona’s interlocking tabs.
 * Renders the bundled vector asset. The component name stays stable for upstream callers.
 */
export function Cube({ size = 28, glow = true, className }: Props): JSX.Element {
  return (
    <img
      src={logoUrl}
      alt="Sekvona"
      width={size}
      height={size}
      className={className}
      style={{
        display: "block",
        flexShrink: 0,
        filter: glow ? `drop-shadow(0 ${size * 0.15}px ${size * 0.5}px rgba(180, 226, 255, 0.18))` : undefined,
      }}
    />
  );
}
