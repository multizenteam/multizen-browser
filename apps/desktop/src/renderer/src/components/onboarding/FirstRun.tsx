import { useState, type JSX } from "react";
import { Cube } from "../atoms";

interface Props {
  onCreate: (name: string, tags: string[]) => Promise<void>;
}

const DEFAULT_NAME = "My first profile";

/**
 * Two-step first-run: welcome → name a profile.
 * We omit the Anthropic-key step from the original Claude Design output because
 * Sekvona no longer calls any external API.
 *
 * The final step asks for one thing, a name; tags / proxy / fingerprint are
 * editable later from the profile panel.
 */
export function FirstRun({ onCreate }: Props): JSX.Element {
  const [step, setStep] = useState<1 | 2>(1);
  // Pre-filled with the default. The input below auto-selects on focus,
  // so the user can hit Enter to accept or just start typing to replace.
  const [name, setName] = useState(DEFAULT_NAME);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      await onCreate(name.trim() || DEFAULT_NAME, []);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center"
      style={{
        background: "#0c1726",
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
          background: "radial-gradient(circle, rgba(180,226,255,0.10), transparent 70%)",
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
        <div className="text-[12px] uppercase tracking-[0.3em] text-[#b4e2ff]">Sekvona</div>

        {step === 1 && (
          <>
            <div>
              <div
                className="font-bold tracking-tight text-slate-100"
                style={{ fontSize: 30, lineHeight: 1.1, letterSpacing: "-0.02em" }}
              >
                A browser workspace for every project.
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
          {[1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: i === step ? 22 : 6,
                height: 6,
                borderRadius: 3,
                background: i === step ? "#b4e2ff" : "rgba(255,255,255,0.08)",
                transition: "width 240ms cubic-bezier(0.2,0.8,0.2,1)",
              }}
            />
          ))}
        </div>
      </div>

    </div>
  );
}
