import { useEffect, useRef, useState, type JSX } from "react";
import Picker from "@emoji-mart/react";
import emojiData from "@emoji-mart/data";
import { Avatar } from "../atoms";
import { defaultEmoji, profileEmoji } from "../../lib/profileEmoji";
import { emojiTint } from "../../lib/emojiTint";

/**
 * Avatar emoji picker for create/edit. Shows the resolved avatar (the custom
 * pick, else the classifier default from name/tags) and, on click, a full
 * searchable emoji picker (emoji-mart, native emojis, local data — no network).
 * An "Auto" reset clears the custom pick so the profile falls back to the
 * derived default. `value === undefined` means "no custom icon" (auto); a
 * non-empty string is the user's chosen emoji.
 */
export function EmojiField({
  value,
  onChange,
  name,
  tags,
  id,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  name: string;
  tags: string[];
  /** Real profile id when editing; on create pass undefined (seeded from name). */
  id?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // On create there's no id yet — seed the default off the name so the preview
  // is stable while typing. The real card re-derives from the uuid post-create.
  const seed = id ?? (name.trim() || "new-profile");
  const shown = profileEmoji(value, name, tags, seed);
  const derived = defaultEmoji(name, tags, seed);
  const tint = emojiTint(shown);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      // Clicks inside the picker's shadow DOM retarget to the <em-emoji-picker>
      // host, which lives inside `ref` — so this correctly ignores them.
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Set an emoji avatar"
        className="relative block rounded-[11px] transition-transform hover:scale-[1.03]"
        aria-label="Choose emoji avatar"
      >
        <Avatar emoji={shown} tint={tint} size={44} />
      </button>

      {open && (
        <div
          className="absolute z-50 mt-2 rounded-xl overflow-hidden mz-slide-up"
          style={{ boxShadow: "0 20px 40px rgba(0,0,0,0.6)" }}
        >
          <div
            className="flex items-center justify-between px-3 py-2"
            style={{
              background: "rgba(15,16,22,0.98)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
            }}
          >
            <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">
              Emoji avatar
            </span>
            <button
              type="button"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              className={
                value === undefined
                  ? "text-[10px] font-semibold text-purple-300"
                  : "text-[10px] font-semibold text-slate-400 hover:text-slate-200 transition-colors"
              }
              title={`Auto — classifier picks ${derived}`}
            >
              Auto {derived}
            </button>
          </div>
          <Picker
            data={emojiData}
            onEmojiSelect={(emoji: { native?: string }) => {
              if (emoji.native) onChange(emoji.native);
              setOpen(false);
            }}
            theme="dark"
            set="native"
            previewPosition="none"
            skinTonePosition="search"
            navPosition="top"
            perLine={8}
            maxFrequentRows={1}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}
