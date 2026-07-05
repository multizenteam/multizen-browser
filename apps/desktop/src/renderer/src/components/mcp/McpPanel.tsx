import { useMemo, useState, type JSX } from "react";
import { Check, Copy, Plug, Terminal } from "lucide-react";
import type { ActivityEvent, ProfileSummary } from "../../types";
import { Pill, Flag, ccFromTimezone } from "../atoms";
import { formatTime } from "../../lib/relativeTime";

interface Props {
  events: ActivityEvent[];
  profiles: ProfileSummary[];
  /** MCP HTTP base URL (e.g. http://127.0.0.1:7777) or null when the server is off. */
  mcpUrl: string | null;
}

/**
 * MCP panel: the one place to connect an AI agent to MultiZen and watch what it
 * does. Top half = a "Connect an agent" card (endpoint + copy-paste client
 * config); bottom half = the live feed of MCP tool calls.
 */
export function McpPanel({ events, profiles, mcpUrl }: Props): JSX.Element {
  const profilesById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const recent = useMemo(() => events.slice().reverse(), [events]);

  const sseUrl = mcpUrl ? `${mcpUrl.replace(/\/$/, "")}/sse` : null;

  return (
    <div className="flex-1 overflow-auto" style={{ padding: "24px 32px" }}>
      <div className="max-w-[960px] mx-auto">
        <div className="flex items-baseline gap-3 mb-1.5">
          <div className="text-lg font-bold tracking-tight text-slate-100">MCP</div>
          <div className="mono text-[11px] text-slate-600">·  {events.length} calls</div>
        </div>
        <div className="text-[13px] text-slate-500 mb-5 leading-relaxed max-w-[68ch]">
          Drive your profiles from an AI agent. Point any MCP client (Claude Desktop, Cursor,
          Cline, …) at MultiZen, then launch a profile and let the agent open tabs, click, type,
          and read pages through it — every tool call streams into the feed below.
        </div>

        <ConnectCard sseUrl={sseUrl} />

        {/* Live feed */}
        <div className="flex items-baseline gap-2.5 mt-7 mb-2.5">
          <div className="text-[13px] font-semibold text-slate-200">Live tool calls</div>
          <div className="mono text-[10px] text-slate-600">{events.length} total</div>
        </div>

        {recent.length === 0 ? (
          <div
            className="text-center"
            style={{
              padding: 40,
              borderRadius: 18,
              background: "rgba(255,255,255,0.02)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
            }}
          >
            <div className="text-[13px] font-semibold text-slate-100">No agent calls yet</div>
            <div className="text-[12px] text-slate-500 mt-1.5 leading-relaxed max-w-[46ch] mx-auto">
              Connect a client above, launch a profile, and every MCP tool call the agent makes
              shows up here — with sanitized arguments, outcome, and duration.
            </div>
          </div>
        ) : (
          <div className="mz-card overflow-hidden">
            {recent.map((e, i) => (
              <PageRow
                key={e.id}
                event={e}
                profile={e.profileId ? profilesById.get(e.profileId) : undefined}
                isLast={i === recent.length - 1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectCard({ sseUrl }: { sseUrl: string | null }): JSX.Element {
  const off = sseUrl === null;
  const url = sseUrl ?? "http://127.0.0.1:7777/sse";
  // Two honest config shapes: URL-based clients (Cursor, Cline) speak SSE
  // directly; stdio-only clients (Claude Desktop) need the `mcp-remote` bridge —
  // its config-file format has no `url` key.
  const sseConfig = useMemo(
    () => JSON.stringify({ mcpServers: { multizen: { type: "sse", url } } }, null, 2),
    [url],
  );
  const stdioConfig = useMemo(
    () =>
      JSON.stringify(
        { mcpServers: { multizen: { command: "npx", args: ["mcp-remote", url] } } },
        null,
        2,
      ),
    [url],
  );

  return (
    <div
      style={{
        borderRadius: 18,
        background: "rgba(255,255,255,0.025)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06), 0 24px 48px -24px rgba(0,0,0,0.5)",
        padding: 18,
      }}
    >
      <div className="flex items-center gap-2.5 mb-3">
        <div
          className="flex items-center justify-center"
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            background: "rgba(168,85,247,0.12)",
            color: "#c084fc",
            boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.22)",
          }}
        >
          <Plug size={15} strokeWidth={1.75} />
        </div>
        <div className="text-[13px] font-semibold text-slate-100">Connect an agent</div>
        <div className="ml-auto">
          {off ? (
            <Pill kind="idle">server off</Pill>
          ) : (
            <Pill kind="running" dot>listening</Pill>
          )}
        </div>
      </div>

      {off ? (
        <div className="text-[12px] text-slate-400 leading-relaxed">
          The MCP server is disabled. Turn on{" "}
          <span className="text-slate-200 font-medium">Auto-start MCP HTTP transport</span> in{" "}
          <span className="text-slate-200 font-medium">Settings</span> to get a connection
          endpoint.
        </div>
      ) : (
        <>
          {/* Endpoint */}
          <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
            Endpoint (HTTP/SSE)
          </div>
          <CopyRow value={sseUrl} mono />

          {/* Steps */}
          <ol className="mt-4 space-y-2">
            <Step n={1}>Copy the config for your client below into its MCP config.</Step>
            <Step n={2}>Reload / restart the client so it connects.</Step>
            <Step n={3}>Launch a profile here, and let the agent drive it.</Step>
          </ol>

          {/* Config snippets — two honest shapes by client type */}
          <div className="mt-4 space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
                URL clients — Cursor, Cline, Continue
              </div>
              <CopyRow value={sseConfig} mono block />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
                Stdio clients — Claude Desktop
              </div>
              <CopyRow value={stdioConfig} mono block />
              <div className="flex items-start gap-1.5 mt-2 text-[11px] text-slate-500 leading-relaxed">
                <Terminal size={12} className="mt-[2px] flex-shrink-0 text-slate-600" />
                <span>
                  Claude Desktop&apos;s config has no <code className="text-slate-400">url</code>{" "}
                  field, so it bridges the SSE endpoint through{" "}
                  <code className="text-slate-400">mcp-remote</code> (needs Node). Change the port
                  in <span className="text-slate-400">Settings</span>.
                </span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }): JSX.Element {
  return (
    <li className="flex items-start gap-2.5 text-[12px] text-slate-300 leading-relaxed">
      <span
        className="flex-shrink-0 flex items-center justify-center mono text-[10px] font-semibold"
        style={{
          width: 18,
          height: 18,
          borderRadius: 6,
          marginTop: 1,
          background: "rgba(255,255,255,0.05)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
          color: "#94a3b8",
        }}
      >
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

function CopyRow({
  value,
  mono,
  block,
}: {
  value: string;
  mono?: boolean;
  block?: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  function copy(): void {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {
        /* clipboard denied (non-secure context) — no-op */
      });
  }
  return (
    <div
      className="flex items-start gap-2"
      style={{
        borderRadius: 10,
        background: "rgba(0,0,0,0.25)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
        padding: block ? "10px 10px 10px 12px" : "9px 9px 9px 12px",
      }}
    >
      <pre
        className={mono ? "mono" : ""}
        style={{
          flex: 1,
          minWidth: 0,
          margin: 0,
          fontSize: block ? 11 : 12,
          lineHeight: 1.5,
          color: "#cbd5e1",
          whiteSpace: block ? "pre" : "nowrap",
          overflowX: "auto",
        }}
      >
        {value}
      </pre>
      <button
        type="button"
        onClick={copy}
        title="Copy"
        className="flex-shrink-0 flex items-center justify-center transition-colors"
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: copied ? "rgba(16,185,129,0.14)" : "rgba(255,255,255,0.04)",
          boxShadow: copied
            ? "inset 0 0 0 1px rgba(16,185,129,0.3)"
            : "inset 0 0 0 1px rgba(255,255,255,0.08)",
          color: copied ? "#6ee7b7" : "#94a3b8",
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

function PageRow({
  event,
  profile,
  isLast,
}: {
  event: ActivityEvent;
  profile?: ProfileSummary;
  isLast: boolean;
}): JSX.Element {
  const cc = profile
    ? ccFromTimezone(profile.tags.find((t) => t.startsWith("tz:"))?.slice(3))
    : undefined;
  return (
    <div
      className="flex items-start gap-3"
      style={{
        padding: "12px 18px",
        borderBottom: isLast ? "none" : "1px solid rgba(255,255,255,0.04)",
        background: event.status === "pending" ? "rgba(168,85,247,0.04)" : undefined,
      }}
    >
      <StatusPill status={event.status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <code className="mono text-[12px] font-semibold text-slate-100">
            <span className="text-purple-400">multizen.</span>
            {event.tool}
          </code>
          <span className="ml-auto mono text-[10px] text-slate-500">
            {formatTime(event.timestamp)}
            {event.durationMs !== undefined && ` · ${event.durationMs}ms`}
          </span>
        </div>
        {event.summary && (
          <div className="text-[12px] text-slate-400 mt-0.5 truncate">{event.summary}</div>
        )}
        {profile && (
          <div className="mono text-[10px] text-slate-500 mt-1 flex items-center gap-1.5">
            <Flag cc={cc} />
            {profile.name} · {profile.id.slice(0, 12)}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: ActivityEvent["status"] }): JSX.Element {
  if (status === "ok") return <Pill kind="running">ok</Pill>;
  if (status === "pending") return <Pill kind="ai" dot>live</Pill>;
  return <Pill kind="error">error</Pill>;
}
