import { useEffect, useState, type JSX, type ReactNode } from "react";
import {
  Boxes,
  Check,
  Chrome,
  Copy,
  DownloadCloud,
  Eye,
  EyeOff,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { Pill } from "../atoms";
import { relativeTime } from "../../lib/relativeTime";
import type { AppSettings, SystemInfo, UpdateStatus } from "../../types";

interface Props {
  onImport: () => void;
}

export function Settings({ onImport }: Props): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [tokenShown, setTokenShown] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [lastChecked, setLastChecked] = useState<number>(0);

  useEffect(() => {
    if (!window.multizen) return;
    void window.multizen.settings.get().then(setSettings);
    void window.multizen.system.info().then(setInfo);
    void window.multizen.update.status().then(setUpdateStatus);
    void window.multizen.update.lastChecked().then(setLastChecked);
    // Refresh "last checked" on every status change too, so a background
    // auto-check updates the label live while Settings is open.
    return window.multizen.update.onStatus((s) => {
      setUpdateStatus(s);
      void window.multizen.update.lastChecked().then(setLastChecked);
    });
  }, []);

  async function patch(p: Partial<AppSettings>): Promise<void> {
    if (!settings) return;
    const next = await window.multizen.settings.update(p);
    setSettings(next);
  }

  async function checkForUpdates(): Promise<void> {
    await window.multizen.update.check();
    setLastChecked(await window.multizen.update.lastChecked());
  }

  function copyMcpUrl(): void {
    if (!info?.mcpHttpUrl) return;
    navigator.clipboard.writeText(info.mcpHttpUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function copyMcpToken(): void {
    if (!info?.mcpAuthToken) return;
    navigator.clipboard.writeText(info.mcpAuthToken);
    setTokenCopied(true);
    window.setTimeout(() => setTokenCopied(false), 1500);
  }

  if (!settings) {
    return (
      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-[720px] mx-auto text-[13px] text-slate-500">Loading…</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto" style={{ padding: "24px 32px" }}>
      <div className="max-w-[720px] mx-auto">
        <div className="text-lg font-bold tracking-tight text-slate-100 mb-1.5">Settings</div>
        <div className="text-[13px] text-slate-500 mb-5">
          MCP server, archives, build info. Configuration is local — MultiZen does not call any
          external API on your behalf.
        </div>

        <Row
          icon={<Zap size={16} strokeWidth={1.5} />}
          title="MCP server"
          desc="Local HTTP transport that Cursor / Claude Desktop / Cline / any MCP client connects to. Add this URL to your client config."
        >
          <div className="flex gap-2 items-center flex-wrap">
            <Pill kind={info?.mcpHttpUrl ? "running" : "idle"} dot={!!info?.mcpHttpUrl}>
              {info?.mcpHttpUrl ? `running on :${settings.mcpHttpPort}` : "off"}
            </Pill>

            {info?.mcpHttpUrl && (
              <div
                className="flex-1 min-w-[260px] flex items-center gap-2"
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.03)",
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
                }}
              >
                <span className="flex-1 mono text-[12px] text-slate-300 truncate">
                  {info.mcpHttpUrl}
                </span>
                <button
                  type="button"
                  onClick={copyMcpUrl}
                  className="text-purple-400 hover:text-purple-300 transition-colors"
                  aria-label="Copy URL"
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
            )}
          </div>

          {info?.mcpAuthToken && (
            <div className="mt-2">
              <div className="text-[11px] text-slate-500 mb-1">
                Auth token — required. Send as{" "}
                <span className="mono text-slate-400">Authorization: Bearer &lt;token&gt;</span>. Keep
                it secret.
              </div>
              <div
                className="flex items-center gap-2"
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.03)",
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
                }}
              >
                <span className="flex-1 mono text-[12px] text-slate-300 truncate">
                  {tokenShown ? info.mcpAuthToken : "•".repeat(24)}
                </span>
                <button
                  type="button"
                  onClick={() => setTokenShown((v) => !v)}
                  className="text-slate-400 hover:text-slate-200 transition-colors"
                  aria-label={tokenShown ? "Hide token" : "Reveal token"}
                >
                  {tokenShown ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  type="button"
                  onClick={copyMcpToken}
                  className="text-purple-400 hover:text-purple-300 transition-colors"
                  aria-label="Copy token"
                >
                  {tokenCopied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
            </div>
          )}

          <label className="flex items-center gap-2.5 mt-3 text-[12px] text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.mcpHttpEnabled}
              onChange={(e) => void patch({ mcpHttpEnabled: e.target.checked })}
              className="w-3.5 h-3.5 rounded accent-purple-500"
            />
            Auto-start MCP HTTP transport on app launch
          </label>
        </Row>

        <Row
          icon={<Chrome size={16} strokeWidth={1.5} />}
          title="Browser engine"
          desc="Applied on next app launch."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {engineOptions.map((option) => {
              const selected = settings.browserEngine === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => void patch({ browserEngine: option.value })}
                  className="text-left p-3 rounded-lg transition-colors"
                  style={{
                    boxShadow: selected
                      ? "inset 0 0 0 1px rgba(168,85,247,0.45)"
                      : "inset 0 0 0 1px rgba(255,255,255,0.07)",
                    background: selected ? "rgba(168,85,247,0.08)" : "rgba(255,255,255,0.025)",
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-slate-100">{option.label}</span>
                    {selected && <Pill kind="running">active</Pill>}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
        </Row>

        <Row
          icon={<Boxes size={16} strokeWidth={1.5} />}
          title="Archives"
          desc=".mzar files are encrypted bundles of profiles — cookies, login state, fingerprints, notes — protected with a passphrase you set at export time."
        >
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary px-3 py-[7px] text-[12px] rounded-[9px]"
              onClick={onImport}
            >
              Import .mzar archive
            </button>
            <a
              href="https://github.com/multizenteam/multizen-browser#archives"
              target="_blank"
              rel="noopener"
              className="btn-ghost px-3 py-[7px] text-[12px] rounded-[9px]"
            >
              Read archive format docs
            </a>
          </div>
        </Row>

        <Row
          icon={<DownloadCloud size={16} strokeWidth={1.5} />}
          title="Updates"
          desc={
            info?.platform === "darwin"
              ? "Auto-install isn't available on macOS yet — we'll notify you in-app to download the new version."
              : "MultiZen checks for updates in the background and installs them on restart."
          }
        >
          <div className="flex items-center gap-2.5 flex-wrap">
            <button
              type="button"
              className="btn-secondary px-3 py-[7px] text-[12px] rounded-[9px] inline-flex items-center gap-1.5"
              onClick={() => void checkForUpdates()}
              disabled={updateStatus?.kind === "checking"}
            >
              <RefreshCw
                size={12}
                className={updateStatus?.kind === "checking" ? "animate-spin" : ""}
              />
              Check for updates
            </button>
            <span className="text-[12px] text-slate-400">{updateLabel(updateStatus)}</span>
          </div>
          <div className="text-[11px] text-slate-600 mt-2">
            Last checked: {lastChecked ? relativeTime(new Date(lastChecked).toISOString()) : "never"}
          </div>
          <label className="flex items-center gap-2.5 mt-3 text-[12px] text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.autoUpdate}
              onChange={(e) => void patch({ autoUpdate: e.target.checked })}
              className="w-3.5 h-3.5 rounded accent-purple-500"
            />
            Automatically check for updates
          </label>
        </Row>

        <Row
          icon={<ShieldCheck size={16} strokeWidth={1.5} />}
          title="Anonymous usage"
          desc="Off by default. Help gauge how many people run MultiZen."
        >
          <label className="flex items-center gap-2.5 text-[12px] text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.usageReporting}
              onChange={(e) => void patch({ usageReporting: e.target.checked })}
              className="w-3.5 h-3.5 rounded accent-purple-500"
            />
            Send an anonymous daily heartbeat
          </label>
          <div className="text-[11px] text-slate-600 mt-2 leading-relaxed">
            When on, sends once a day: app version, OS family, and a random
            single-use token — <b>no</b> account, <b>no</b> persistent ID, and your IP is
            never stored (a coarse country is derived server-side then discarded). No
            profiles, proxies, or browsing are ever included. Set{" "}
            <code className="text-slate-500">MULTIZEN_NO_TELEMETRY=1</code> to force it off.
          </div>
        </Row>

        <Row icon={<Sparkles size={16} strokeWidth={1.5} />} title="About" desc="">
          <div className="mono text-[12px] text-slate-400 leading-relaxed">
            MultiZen v{info?.appVersion ?? "0.0.0"} · {info?.platform ?? "—"} · Electron{" "}
            {electronVersion()}
          </div>
        </Row>
      </div>
    </div>
  );
}

const engineOptions: Array<{
  value: AppSettings["browserEngine"];
  label: string;
  description: string;
}> = [
  {
    value: "cloakbrowser",
    label: "CloakBrowser",
    description: "Source-patched Chromium from CloakHQ releases. Primary runtime.",
  },
  {
    value: "cft",
    label: "Chrome for Testing",
    description: "Compatibility fallback using Google's official automation build.",
  },
];

function electronVersion(): string {
  // Vite injects nothing useful here; just use a stable string for now.
  return "33";
}

function updateLabel(status: UpdateStatus | null): string {
  switch (status?.kind) {
    case "checking":
      return "Checking…";
    case "up-to-date":
      return "You're on the latest version";
    case "available":
      return `v${status.version} available`;
    case "downloading":
      return `Downloading v${status.version}… ${status.percent}%`;
    case "ready":
      return `v${status.version} ready — restart to update`;
    case "error":
      return `Check failed: ${status.message}`;
    default:
      return "";
  }
}

function Row({
  icon,
  title,
  desc,
  children,
}: {
  icon: ReactNode;
  title: string;
  desc: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      className="flex items-start gap-3.5"
      style={{
        padding: "16px 0",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      <div
        className="flex items-center justify-center flex-shrink-0"
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: "rgba(168,85,247,0.10)",
          boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.18)",
          color: "#c084fc",
        }}
      >
        {icon}
      </div>
      <div className="flex-1">
        <div className="text-[13px] font-semibold text-slate-100">{title}</div>
        {desc && (
          <div className="text-[12px] text-slate-500 mt-1 leading-relaxed max-w-[480px]">
            {desc}
          </div>
        )}
        {children && <div className="mt-2.5">{children}</div>}
      </div>
    </div>
  );
}
