import { useState, type JSX } from "react";
import { Cube } from "../atoms";

interface Props {
  onCreate: (name: string, tags: string[]) => Promise<void>;
}

const DEFAULT_NAME = "My first profile";

/**
 * Three-step first-run: welcome → anonymous-usage consent → name a profile.
 * We omit the Anthropic-key step from the original Claude Design output because
 * MultiZen no longer calls any external API.
 *
 * The telemetry step is a deliberate opt-in ASK (Homebrew's rule: no ping
 * before the notice). The heartbeat stays OFF unless the user clicks Enable —
 * "Not now" leaves it off. The final step asks for one thing, a name; tags /
 * proxy / fingerprint are editable later from the profile panel.
 */
export function FirstRun({ onCreate }: Props): JSX.Element {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  // Pre-filled with the default. The input below auto-selects on focus,
  // so the user can hit Enter to accept or just start typing to replace.
  const [name, setName] = useState(DEFAULT_NAME);
  const [telemetry, setTelemetry] = useState(false);
  const [busy, setBusy] = useState(false);

  // Record the telemetry choice, then advance to the final (name) step.
  function chooseTelemetry(enabled: boolean): void {
    setTelemetry(enabled);
    setStep(3);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      // Apply the consent choice before the first heartbeat could ever fire.
      // Best-effort: a settings hiccup must not block getting into the app.
      try {
        await window.multizen.settings.update({ usageReporting: telemetry });
      } catch {
        /* leave the default (off) */
      }
      await onCreate(name.trim() || DEFAULT_NAME, []);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center"
      style={{
        background: "#0a0b0f",
        padding: 48,
        overflow: "hidden",
      }}
    >
      {/* Drag strip — invisible band at the top so the window can be dragged
          even though we don't render the TopBar on the onboarding screen.
          Sits behind the halo and content. */}
      <div
        aria-hidden
        className="drag-region"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 44,
          zIndex: 1,
        }}
      />

      {/* Halo */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          width: 600,
          height: 600,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(168,85,247,0.10), transparent 70%)",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          pointerEvents: "none",
        }}
      />

      <div
        className="relative flex flex-col items-center gap-5 text-center"
        style={{ maxWidth: 520 }}
      >
        <Cube size={88} />

        {step === 1 && (
          <>
            <div>
              <div
                className="font-bold tracking-tight text-slate-100"
                style={{ fontSize: 30, lineHeight: 1.1, letterSpacing: "-0.02em" }}
              >
                A library of isolated browsers.
              </div>
              <div className="text-[14px] text-slate-400 mt-3 leading-relaxed">
                Cookies, login, fingerprint, and proxy isolated per profile.
                Drive them yourself or via any MCP agent.
              </div>
            </div>
            <div className="flex items-center gap-3 mt-1.5 mono text-[11px] text-slate-500">
              <span>macOS</span>
              <span className="text-slate-700">·</span>
              <span>Windows</span>
              <span className="text-slate-700">·</span>
              <span>Linux</span>
              <span className="text-slate-700">·</span>
              <span>Chromium</span>
              <span className="text-slate-700">·</span>
              <span>MCP HTTP</span>
            </div>
            <button
              type="button"
              onClick={() => setStep(2)}
              className="btn-brand text-[13px] mt-2"
              style={{ padding: "10px 16px", borderRadius: 11 }}
            >
              Continue
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <div>
              <div
                className="font-bold tracking-tight text-slate-100"
                style={{ fontSize: 26, lineHeight: 1.15, letterSpacing: "-0.01em" }}
              >
                Help improve MultiZen?
              </div>
              <div className="text-[13px] text-slate-400 mt-2.5 leading-relaxed">
                Optionally send an anonymous daily heartbeat: just app version and
                OS family. No account, no persistent ID, and your IP is never
                stored. No profiles, proxies, or browsing — ever. Off unless you
                enable it; change it anytime in Settings.
              </div>
            </div>
            <div className="flex items-center gap-2.5 mt-1">
              <button
                type="button"
                onClick={() => chooseTelemetry(true)}
                className="btn-brand text-[13px]"
                style={{ padding: "10px 16px", borderRadius: 11 }}
              >
                Enable
              </button>
              <button
                type="button"
                onClick={() => chooseTelemetry(false)}
                className="btn-ghost text-[13px]"
                style={{ padding: "10px 16px", borderRadius: 11 }}
              >
                Not now
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <div
                className="font-bold tracking-tight text-slate-100"
                style={{ fontSize: 26, lineHeight: 1.15, letterSpacing: "-0.01em" }}
              >
                Name your first profile.
              </div>
              <div className="text-[13px] text-slate-400 mt-2.5 leading-relaxed">
                Just a label to find it later. Tags, proxy, and fingerprint are
                editable anytime from the profile panel.
              </div>
            </div>
            <div className="w-full text-left">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) void submit();
                }}
                placeholder={DEFAULT_NAME}
                className="w-full px-4 py-3 rounded-xl bg-white/[0.03] text-[14px] text-slate-100 placeholder:text-slate-600 outline-none focus:bg-white/[0.05] transition-colors mono"
                style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
              />
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="btn-brand text-[13px] mt-2"
              style={{ padding: "10px 16px", borderRadius: 11 }}
            >
              {busy ? "Creating…" : "Create profile"}
            </button>
          </>
        )}

        {/* Step indicator */}
        <div className="flex gap-1.5 mt-2">
          {[1, 2, 3].map((i) => (
            <span
              key={i}
              style={{
                width: i === step ? 22 : 6,
                height: 6,
                borderRadius: 3,
                background: i === step ? "linear-gradient(90deg, #a855f7, #ec4899)" : "rgba(255,255,255,0.08)",
                transition: "width 240ms cubic-bezier(0.2,0.8,0.2,1)",
              }}
            />
          ))}
        </div>
      </div>

    </div>
  );
}
