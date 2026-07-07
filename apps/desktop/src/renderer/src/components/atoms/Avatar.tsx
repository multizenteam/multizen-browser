import type { CSSProperties, JSX } from "react";
import type { EmojiTint } from "../../lib/emojiTint";

interface Props {
  /** Initials to render when no emoji is provided (legacy / fallback). */
  initials?: string;
  /** Emoji avatar — when set, rendered on a tinted glass well instead of initials. */
  emoji?: string;
  /** Deterministic hue/chroma sampled from the emoji (see emojiTint). When the
   *  emoji is colourful, the well picks up a whisper of its hue; grey emojis
   *  stay neutral. Omit for a plain neutral well. */
  tint?: EmojiTint;
  /** Purple treatment for AI-driven profiles. Overrides any emoji tint. */
  accent?: boolean;
  size?: number;
}

/**
 * Profile avatar rendered as an "inset glass well": the same material family as
 * the surrounding cards, just a touch more opaque, with a hairline border, a
 * soft top light-edge, and a small grounding shadow for real (not haloed)
 * depth. Colourful emojis lend the well a very quiet tint; neutral emojis and
 * initials stay monochrome. AI profiles get a purple well.
 */
export function Avatar({ initials, emoji, tint, accent = false, size = 32 }: Props): JSX.Element {
  const radius = Math.round(size * 0.3);
  const surface = wellSurface({ radius, size, tint, accent });

  if (emoji) {
    return (
      <div style={surface} className="flex items-center justify-center">
        <span
          style={{
            // 0.56 keeps the glyph confidently filling the well without kissing
            // the edges at 32 / 40 / 44 (≈18 / 22 / 25px).
            fontSize: Math.round(size * 0.56),
            lineHeight: 1,
            // Nudge down a hair — Apple Color Emoji glyphs sit slightly high in
            // their em box, so pure flex-centering reads a touch top-heavy.
            transform: `translateY(${(size * 0.02).toFixed(2)}px)`,
            filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,0.28))",
          }}
        >
          {emoji}
        </span>
      </div>
    );
  }

  return (
    <div
      style={{ ...surface, color: accent ? "#e9d5ff" : "#cbd5e1" }}
      className="flex items-center justify-center font-semibold"
    >
      <span style={{ fontSize: Math.max(11, size / 2.5), lineHeight: 1 }}>{initials}</span>
    </div>
  );
}

/**
 * Compose the well's background + shadow stack. Deterministic per profile:
 * same emoji tint (or accent) → same surface, every render.
 */
function wellSurface({
  radius,
  size,
  tint,
  accent,
}: {
  radius: number;
  size: number;
  tint?: EmojiTint;
  accent: boolean;
}): CSSProperties {
  // A colourful emoji (chroma above the floor) lends its hue to the well at a
  // low, restrained saturation; grey/near-grey emojis fall back to neutral.
  const tinted = !accent && tint !== undefined && tint.chroma >= 0.12;
  const hue = accent ? 276 : tinted ? tint.hue : 222;
  const sat = accent ? 34 : tinted ? Math.round(10 + Math.min(tint.chroma, 0.9) * 12) : 8;
  const topL = accent ? 26 : 17;
  const botL = accent ? 17 : 12;

  const border = accent ? "rgba(168,85,247,0.34)" : "rgba(255,255,255,0.07)";

  return {
    width: size,
    height: size,
    borderRadius: radius,
    flexShrink: 0,
    background: `linear-gradient(160deg, hsl(${hue} ${sat}% ${topL}%), hsl(${hue} ${sat}% ${botL}%))`,
    boxShadow: [
      // top light-edge — light from above, subtle bevel
      "inset 0 1px 0 rgba(255,255,255,0.10)",
      // hairline border, matches the card language
      `inset 0 0 0 1px ${border}`,
      // grounds the tile without a coloured halo
      "0 1px 2px rgba(0,0,0,0.35)",
      // accent adds only the faintest purple lift, never a neon glow
      accent ? "0 2px 10px -4px rgba(168,85,247,0.35)" : "0 0 0 0 rgba(0,0,0,0)",
    ].join(", "),
  };
}

export function profileInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/[\s\-_·.]+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}
