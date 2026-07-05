/**
 * Derive a subtle, deterministic tint from the CHOSEN EMOJI's own colour.
 *
 * We render the emoji to a small offscreen canvas and sample its pixels for a
 * dominant hue, weighting vivid pixels over grey ones. The result is NOT a loud
 * colour — it's just a hue + a "how colourful is this emoji" measure. The actual
 * visual treatment (a quiet tinted glass surface, no neon glow) lives in
 * `Avatar`, which decides how much of the hue to show.
 *
 * Deterministic per emoji and memoised — the same emoji always yields the same
 * look. Runs in the renderer (needs a DOM canvas); falls back to a neutral,
 * chroma-0 tint if the canvas/sampling is unavailable.
 */

export interface EmojiTint {
  /** Dominant hue in degrees [0, 360). Meaningless when `chroma` is ~0. */
  hue: number;
  /** How vivid the emoji is, [0, 1]. Low values → render as a neutral tile. */
  chroma: number;
}

const FALLBACK: EmojiTint = { hue: 220, chroma: 0 };

const cache = new Map<string, EmojiTint>();

export function emojiTint(emoji: string): EmojiTint {
  const key = emoji || "?";
  const hit = cache.get(key);
  if (hit) return hit;
  const tint = compute(key);
  cache.set(key, tint);
  return tint;
}

function compute(emoji: string): EmojiTint {
  try {
    const size = 28;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return FALLBACK;
    ctx.clearRect(0, 0, size, size);
    ctx.font = `${Math.round(size * 0.8)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(emoji, size / 2, size / 2 + 1);

    const { data } = ctx.getImageData(0, 0, size, size);
    let wr = 0;
    let wg = 0;
    let wb = 0;
    let wsum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] ?? 0;
      if (a < 16) continue;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      // Weight vivid pixels much more than grey ones, but keep a small floor so
      // an all-grey/black emoji (e.g. ⚙️) still produces a stable average.
      const w = (a / 255) * (0.2 + sat);
      wr += r * w;
      wg += g * w;
      wb += b * w;
      wsum += w;
    }
    if (wsum === 0) return FALLBACK;

    const [h, s] = rgbToHs(wr / wsum, wg / wsum, wb / wsum);
    return { hue: Math.round(h), chroma: Math.min(1, Math.max(0, s)) };
  } catch {
    return FALLBACK;
  }
}

/** RGB (0–255) → [hueDeg 0–360, saturation 0–1]. Lightness is discarded. */
function rgbToHs(r: number, g: number, b: number): [number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const mx = Math.max(rn, gn, bn);
  const mn = Math.min(rn, gn, bn);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === rn) h = ((gn - bn) / d) % 6;
    else if (mx === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (mx + mn) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s];
}
