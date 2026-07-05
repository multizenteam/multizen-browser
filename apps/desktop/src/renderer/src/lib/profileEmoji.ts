/**
 * Emoji identity for a profile. If the user picked a custom `icon`, use it.
 * Otherwise derive a stable default: a small keyword classifier over the
 * profile's name + tags (crypto → 🪙, ads → 📢, trading → 📈, …), falling back
 * to a hash-stable pick from a base set so every profile still gets a distinct,
 * deterministic emoji.
 */

/** FNV-1a — small, fast, deterministic string hash. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Category {
  re: RegExp;
  emoji: string;
}

// Ordered — first match wins. Keep these broad but unambiguous.
const CATEGORIES: Category[] = [
  { re: /crypto|wallet|web3|nft|defi|coin|token|metamask|phantom/i, emoji: "🪙" },
  { re: /trad|stock|forex|invest|financ|market|broker/i, emoji: "📈" },
  { re: /\bads?\b|ppc|media.?buy|campaign|marketing|arbitrage/i, emoji: "📢" },
  { re: /social|facebook|\bfb\b|insta|\big\b|tiktok|twitter|reddit/i, emoji: "💬" },
  { re: /shop|ecom|amazon|store|retail|dropship|buyer|seller/i, emoji: "🛒" },
  { re: /game|gaming|steam|casino|bet/i, emoji: "🎮" },
  { re: /bank|\bpay\b|payment|card|paypal/i, emoji: "🏦" },
  { re: /travel|book|flight|hotel|airbnb/i, emoji: "✈️" },
  { re: /\bdev\b|test|local|staging|\bqa\b|debug/i, emoji: "🛠️" },
  { re: /\bai\b|bot|agent|gpt|llm|automation/i, emoji: "🤖" },
  { re: /mail|email|gmail|outlook|inbox/i, emoji: "✉️" },
  { re: /video|youtube|\byt\b|stream|twitch/i, emoji: "🎬" },
  { re: /music|spotify|audio|podcast/i, emoji: "🎵" },
  { re: /work|business|corp|office|client/i, emoji: "💼" },
  { re: /news|blog|content|writer/i, emoji: "📰" },
];

/** Neutral, distinctive fallbacks when no category matches. */
const BASE: readonly string[] = [
  "🦊", "🐙", "🦉", "🐢", "🦋", "🌸", "🌊", "⚡", "🔮", "🎲",
  "🧩", "🍀", "🌿", "🪐", "🌙", "🔷", "🍥", "🎯", "🚀", "🛰️",
];

/** Curated set surfaced in the emoji picker (categories first, then base). */
export const EMOJI_CHOICES: readonly string[] = [
  ...CATEGORIES.map((c) => c.emoji),
  ...BASE,
];

/** The default emoji for a profile that has no custom `icon` set. */
export function defaultEmoji(name: string, tags: string[], id: string): string {
  const hay = `${name} ${tags.join(" ")}`;
  for (const c of CATEGORIES) {
    if (c.re.test(hay)) return c.emoji;
  }
  return BASE[hash(id) % BASE.length] ?? "🔷";
}

/** Resolve the emoji to show: the user's pick, else the derived default. */
export function profileEmoji(
  icon: string | undefined,
  name: string,
  tags: string[],
  id: string,
): string {
  const trimmed = (icon ?? "").trim();
  return trimmed || defaultEmoji(name, tags, id);
}

/**
 * Muted, deterministic background tint for the avatar tile so cards keep colour
 * variety without the emoji clashing. Derived from the profile id.
 */
export function profileTint(id: string): string {
  const h = hash(id);
  const h1 = h % 360;
  const h2 = (h1 + 40) % 360;
  const angle = (h >> 3) % 360;
  return `linear-gradient(${angle}deg, hsl(${h1} 34% 26%), hsl(${h2} 30% 18%))`;
}
