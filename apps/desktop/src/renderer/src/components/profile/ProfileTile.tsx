import { useEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { Loader2, MoreHorizontal, Pencil, Play, RefreshCw, Square, Zap } from "lucide-react";
import type { ProfileSummary } from "../../types";
import {
  Avatar,
  Flag,
  PlatformIcon,
  Pill,
  countryNameFromCc,
  platformFromDeviceFamily,
  platformLabel,
} from "../atoms";
import { Button } from "../atoms/Button";
import { relativeTime } from "../../lib/relativeTime";
import { cn } from "../../lib/cn";
import { profileEmoji } from "../../lib/profileEmoji";
import { emojiTint } from "../../lib/emojiTint";
import { useProxyHealth } from "../../lib/proxyHealth";
import type { ActivityEvent } from "../../types";

export type TileState = "idle" | "running" | "ai" | "error";

export interface TileData extends ProfileSummary {
  state: TileState;
  lastTool?: string;
  lastDuration?: string;
  errorMessage?: string;
}

const RING_BY_STATE: Record<TileState, string> = {
  idle: "rgba(255,255,255,0.05)",
  running: "rgba(16,185,129,0.30)",
  ai: "rgba(168,85,247,0.30)",
  error: "rgba(239,68,68,0.30)",
};

// Use a transparent shadow for idle instead of "none". CSS does not
// accept the literal `none` inside a comma-separated box-shadow list —
// the entire declaration is discarded as invalid, and with the
// `transition-all` on this element the previous (running) shadow keeps
// rendering until something else forces a repaint. A 0-spread
// transparent shadow keeps the syntax valid AND animates cleanly.
const GLOW_BY_STATE: Record<TileState, string> = {
  idle: "0 0 0 0 rgba(0,0,0,0)",
  running: "0 0 32px rgba(16,185,129,0.18)",
  ai: "0 0 32px rgba(168,85,247,0.18)",
  error: "0 0 32px rgba(239,68,68,0.15)",
};

interface Props {
  profile: TileData;
  /** Chromium is winding down (window closed / Stop pressed) but not yet
   *  exited — show a "Terminating…" transitional state instead of "Stop". */
  terminating?: boolean;
  onOpen: () => void;
  onLaunch: () => Promise<void> | void;
  onStop: () => Promise<void> | void;
  onExport: () => void;
  onDelete: () => void;
}

export function ProfileTile({
  profile,
  terminating = false,
  onOpen,
  onLaunch,
  onStop,
  onExport,
  onDelete,
}: Props): JSX.Element {
  const isRunning = profile.state !== "idle";
  // Emoji avatar: user's custom `icon` if set, else a classifier-derived
  // default from name/tags/id, on a deterministic muted tile tint.
  const emoji = profileEmoji(profile.icon, profile.name, profile.tags, profile.id);
  const avatarTint = emojiTint(emoji);

  // Disable Launch/Stop during the actual transition so the user can't
  // double-click and spawn a second Chromium process.
  const [pending, setPending] = useState(false);

  // When the running-state actually flips, clear the pending lock.
  // (External close, MCP-triggered launch, etc. should also unlock.)
  useEffect(() => {
    setPending(false);
  }, [profile.isRunning]);

  async function handleLaunch(): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      await onLaunch();
    } catch {
      setPending(false);
    }
    // pending lifts when isRunning flips via the effect above.
    // Safety net: if the launch never produced a state change (e.g. error toast),
    // unlock after 5s so the button doesn't stay disabled forever.
    window.setTimeout(() => setPending(false), 5000);
  }

  async function handleStop(): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      await onStop();
    } catch {
      setPending(false);
    }
    window.setTimeout(() => setPending(false), 5000);
  }

  return (
    <div
      className="flex flex-col gap-2.5 p-3.5 relative transition-all h-full"
      style={{
        borderRadius: 18,
        background: "rgba(255,255,255,0.025)",
        boxShadow: `inset 0 0 0 1px ${RING_BY_STATE[profile.state]}, 0 24px 48px -16px rgba(0,0,0,0.5), ${GLOW_BY_STATE[profile.state]}`,
        backdropFilter: "blur(20px)",
        transitionTimingFunction: "cubic-bezier(0.2,0.8,0.2,1)",
        transitionDuration: "180ms",
      }}
    >
      {/* Header — clickable, opens the edit modal (where the emoji picker lives) */}
      <button
        type="button"
        onClick={onOpen}
        className="group flex justify-between items-start gap-2.5 cursor-pointer text-left bg-transparent border-0 p-0"
      >
        <div className="flex gap-2.5 items-center min-w-0">
          <div className="relative flex-shrink-0" title="Click to set an emoji">
            <Avatar emoji={emoji} tint={avatarTint} accent={profile.state === "ai"} size={40} />
            <span
              className="absolute -right-1 -bottom-1 w-4 h-4 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              style={{
                background: "#12141a",
                color: "#8b93a3",
                boxShadow: "0 0 0 2px #0b0c10, inset 0 0 0 1px rgba(255,255,255,0.08)",
              }}
            >
              <Pencil size={8} strokeWidth={2} />
            </span>
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-[13px] leading-tight text-slate-100 truncate hover:text-white transition-colors">
              {profile.name}
            </div>
            <div className="mono text-[10px] text-slate-600 mt-[3px] truncate">
              {profile.id.slice(0, 12)}
            </div>
          </div>
        </div>
        <PillForState state={profile.state} />
      </button>

      {/* Tags */}
      {profile.tags.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {profile.tags.slice(0, 4).map((t) => (
            <span
              key={t}
              className="mz-pill mono text-slate-400"
              style={{
                background: "rgba(255,255,255,0.04)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
              }}
            >
              {t}
            </span>
          ))}
          {profile.tags.length > 4 && (
            <span className="mz-pill mono text-slate-600">+{profile.tags.length - 4}</span>
          )}
        </div>
      )}

      {/* Foregrounded proxy row — flag + country + live health (auto-check) */}
      <ProxyHealthRow profile={profile} />

      {/* Context line per state */}
      <ContextLine profile={profile} />

      {/* Bottom meta — platform + last opened */}
      <div className="flex items-center gap-1.5 mono text-[10px] text-slate-600 leading-tight">
        <PlatformIcon
          platform={platformFromDeviceFamily(profile.device)}
          size={12}
          className="text-slate-500"
        />
        <span className="text-slate-500">
          {platformLabel(platformFromDeviceFamily(profile.device))}
        </span>
        <span className="text-slate-700">·</span>
        <span className="truncate">
          {profile.lastOpenedAt ? relativeTime(profile.lastOpenedAt) : "never opened"}
        </span>
      </div>

      {/* Actions — pinned to the card bottom so Launch aligns across a row
          regardless of how much content (tags / context line) sits above. */}
      <div className="flex gap-1.5 mt-auto pt-1">
        {terminating ? (
          <Button
            variant="secondary"
            size="md"
            fullWidth
            disabled
            leftIcon={<Loader2 size={11} className="animate-spin" />}
          >
            Terminating…
          </Button>
        ) : !isRunning ? (
          <Button
            variant="accent"
            size="md"
            fullWidth
            disabled={pending}
            onClick={handleLaunch}
            leftIcon={<Play size={11} fill="currentColor" strokeWidth={0} />}
          >
            {pending ? "Launching…" : "Launch"}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="md"
            fullWidth
            disabled={pending}
            onClick={handleStop}
            leftIcon={<Square size={10} fill="currentColor" strokeWidth={0} />}
          >
            {pending ? "Stopping…" : "Stop"}
          </Button>
        )}
        <ActionMenu onEdit={onOpen} onExport={onExport} onDelete={onDelete} />
      </div>
    </div>
  );
}

/**
 * Foregrounded proxy row: country flag + name + live health. Auto-probes on
 * mount (module-cached + concurrency-limited via useProxyHealth); click to
 * re-check. Direct profiles show a muted "no proxy" line instead.
 */
function ProxyHealthRow({ profile }: { profile: TileData }): JSX.Element {
  const { health, recheck } = useProxyHealth(profile.id, profile.proxy, profile.proxyCountry);

  if (health.status === "direct") {
    return (
      <div
        className="flex items-center gap-2 px-2.5 py-2 rounded-[11px]"
        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)" }}
      >
        <span className="text-[12px] font-semibold text-slate-400 truncate">Direct — no proxy</span>
        <span className="ml-auto mono text-[10px] text-slate-600">host DNS</span>
      </div>
    );
  }

  const cc = health.cc;
  const isError = health.status === "error";
  const label =
    health.status === "ok"
      ? (health.country ?? countryNameFromCc(cc) ?? "Connected")
      : isError
        ? "Proxy unreachable"
        : (countryNameFromCc(cc) ?? "Checking…");
  const title = isError
    ? `${health.error} — click to retry`
    : health.status === "ok"
      ? `${label}${cc ? ` · ${cc.toUpperCase()}` : ""} — click to re-check`
      : "Checking proxy…";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        recheck();
      }}
      title={title}
      className="flex items-center gap-2 px-2.5 py-2 rounded-[11px] w-full text-left border-0 cursor-pointer transition-colors"
      style={
        isError
          ? { background: "rgba(239,68,68,0.06)", boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.22)" }
          : { background: "rgba(255,255,255,0.028)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }
      }
    >
      <span
        className="inline-flex"
        style={isError ? { filter: "grayscale(1)", opacity: 0.7 } : undefined}
      >
        <Flag cc={cc} large />
      </span>
      <span
        className={cn(
          "text-[12.5px] font-semibold truncate",
          isError ? "text-red-300" : "text-slate-200",
        )}
      >
        {label}
      </span>

      {health.status === "ok" && (
        <span className="ml-auto inline-flex items-center gap-1.5">
          {profile.proxy && (
            <span className="mono text-[10px] text-slate-600">proxy</span>
          )}
          <span
            className="w-[7px] h-[7px] rounded-full bg-emerald-500"
            style={{ animation: "mz-dotpulse 1.6s ease-in-out infinite" }}
          />
        </span>
      )}
      {health.status === "checking" && (
        <span
          className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold"
          style={{ color: "#f5b34a" }}
        >
          <Loader2 size={12} className="animate-spin" />
          Checking…
        </span>
      )}
      {isError && (
        <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold text-red-300">
          <RefreshCw size={11} />
          retry
        </span>
      )}
    </button>
  );
}

function PillForState({ state }: { state: TileState }): JSX.Element {
  if (state === "ai") return <Pill kind="ai" dot glow>ai-driven</Pill>;
  if (state === "running") return <Pill kind="running" dot glow>running</Pill>;
  if (state === "error") return <Pill kind="error">error</Pill>;
  return <Pill kind="idle">idle</Pill>;
}

function ContextLine({ profile }: { profile: TileData }): JSX.Element | null {
  if (profile.state === "ai") {
    return (
      <div
        className="flex items-center gap-2 px-2.5 py-2 rounded-lg"
        style={{
          background: "rgba(168,85,247,0.06)",
          boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.12)",
        }}
      >
        <Zap size={12} className="text-purple-400" />
        <span className="mono text-[11px] text-purple-200 truncate flex-1">
          <span className="text-purple-400">multizen.</span>
          {profile.lastTool ?? "…"}
        </span>
        {profile.lastDuration && (
          <span className="mono text-[10px] text-purple-300">{profile.lastDuration}</span>
        )}
      </div>
    );
  }
  if (profile.state === "error" && profile.errorMessage) {
    return (
      <div className="mono text-[11px] leading-tight text-red-400 truncate">
        {profile.errorMessage}
      </div>
    );
  }
  return null;
}

/**
 * Action popover that escapes the tile's clipping. Rendered into a portal
 * with `position: fixed` coordinates so the brand glow / overflow on the
 * tile cannot crop it.
 */
function ActionMenu({
  onEdit,
  onExport,
  onDelete,
}: {
  onEdit: () => void;
  onExport: () => void;
  onDelete: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setCoords({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    });
    function onScroll(): void {
      setOpen(false);
    }
    function onResize(): void {
      setOpen(false);
    }
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <>
      <Button
        ref={triggerRef}
        variant="secondary"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        aria-label="More actions"
      >
        <MoreHorizontal size={14} strokeWidth={1.5} />
      </Button>
      {open && coords &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[60]"
              onMouseDown={() => setOpen(false)}
            />
            <div
              className="fixed z-[61] w-44 py-1 rounded-md"
              style={{
                top: coords.top,
                right: coords.right,
                background: "rgba(15,16,22,0.98)",
                boxShadow:
                  "inset 0 0 0 1px rgba(255,255,255,0.08), 0 20px 40px rgba(0,0,0,0.6)",
                backdropFilter: "blur(20px)",
              }}
            >
              <MenuItem onClick={() => { setOpen(false); onEdit(); }}>
                Edit profile
              </MenuItem>
              <MenuItem onClick={() => { setOpen(false); onExport(); }}>
                Export archive…
              </MenuItem>
              <div style={{ height: 1, margin: "4px 0", background: "rgba(255,255,255,0.06)" }} />
              <MenuItem onClick={() => { setOpen(false); onDelete(); }} tone="danger">
                Delete profile
              </MenuItem>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

function MenuItem({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "danger";
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-1.5 text-[12px] cursor-pointer transition-colors hover:bg-white/[0.05]",
        tone === "danger" ? "text-red-400" : "text-slate-200",
      )}
    >
      {children}
    </button>
  );
}

export function deriveTileState(
  profile: ProfileSummary,
  recentEvents: ActivityEvent[],
): Pick<TileData, "state" | "lastTool" | "lastDuration" | "errorMessage"> {
  if (!profile.isRunning) return { state: "idle" };

  const recent = recentEvents
    .filter((e) => e.profileId === profile.id)
    .slice()
    .reverse();

  const lastError = recent.find((e) => e.status === "error");
  const lastDriveCall = recent.find(
    (e) =>
      e.tool !== "list_profiles" &&
      e.tool !== "launch_profile" &&
      e.tool !== "close_profile",
  );

  if (lastError && Date.now() - new Date(lastError.timestamp).getTime() < 30_000) {
    return { state: "error", errorMessage: lastError.summary };
  }

  if (lastDriveCall && Date.now() - new Date(lastDriveCall.timestamp).getTime() < 8_000) {
    return {
      state: "ai",
      lastTool: lastDriveCall.tool,
      lastDuration: lastDriveCall.durationMs ? `${lastDriveCall.durationMs}ms` : undefined,
    };
  }

  return { state: "running" };
}
