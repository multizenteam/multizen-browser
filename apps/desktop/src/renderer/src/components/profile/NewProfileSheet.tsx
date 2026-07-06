import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Kbd } from "../atoms";
import { FingerprintForm } from "./FingerprintForm";
import { ProxyTester } from "./ProxyTester";
import { ExtensionsSection } from "./ExtensionsSection";
import { EmojiField } from "./EmojiField";
import { BrowserSection, DEFAULT_START_URL } from "./BrowserSection";
import type { ExtensionConfig, FingerprintConfig, ProxyConfig } from "../../types";
import { parseProxyString } from "../../lib/parseProxy";
import {
  Field,
  Input,
  SHEET_HEIGHT,
  SectionRail,
  type SectionId,
} from "./profileSheetKit";

interface Props {
  onCancel: () => void;
  onCreated: (id: string, autoLaunch: boolean) => void;
  /**
   * Reports whether the user has modified anything that would be lost on
   * close. The parent uses this to decide whether to prompt before
   * dismissing.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

interface DraftProxy {
  enabled: boolean;
  type: "http" | "socks5";
  host: string;
  port: string;
  username: string;
  password: string;
}

const EMPTY_PROXY: DraftProxy = {
  enabled: false,
  type: "http",
  host: "",
  port: "",
  username: "",
  password: "",
};

/**
 * Create-profile sheet. Wears the same Discord-settings layout as the edit
 * sheet (shared rail + controls via profileSheetKit) so create and edit feel
 * identical. Unlike edit there's nothing to autosave yet, so a bottom action
 * bar commits the whole draft with Create / Create & launch.
 */
export function NewProfileSheet({ onCancel, onCreated, onDirtyChange }: Props): JSX.Element {
  const [section, setSection] = useState<SectionId>("general");
  const [name, setName] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [icon, setIcon] = useState<string | undefined>(undefined);
  const [startUrl, setStartUrl] = useState(DEFAULT_START_URL);
  const [proxy, setProxy] = useState<DraftProxy>(EMPTY_PROXY);
  const [notes, setNotes] = useState("");
  const [extensions, setExtensions] = useState<ExtensionConfig[]>([]);
  const [fingerprint, setFingerprint] = useState<FingerprintConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parsed tags, used both for the create call and to feed the emoji classifier.
  const tagList = tagsRaw.split(",").map((s) => s.trim()).filter(Boolean);

  // Auto-generate a fingerprint preset on mount so the create call always
  // has one and the regen button has something to replace.
  useEffect(() => {
    if (!window.multizen) return;
    void window.multizen.fingerprint.generate().then(setFingerprint);
  }, []);

  // Track "dirty" — anything the user typed that's not the default. The
  // freshly-generated fingerprint isn't user input so we ignore it.
  const dirtyRef = useRef(false);
  useEffect(() => {
    const dirty =
      name.trim() !== "" ||
      tagsRaw.trim() !== "" ||
      icon !== undefined ||
      notes.trim() !== "" ||
      startUrl.trim() !== DEFAULT_START_URL ||
      proxy.enabled ||
      proxy.host !== "" ||
      proxy.username !== "" ||
      proxy.password !== "" ||
      extensions.length > 0;
    if (dirty !== dirtyRef.current) {
      dirtyRef.current = dirty;
      onDirtyChange?.(dirty);
    }
  }, [name, tagsRaw, icon, notes, startUrl, proxy, extensions, onDirtyChange]);

  function buildProxy(): ProxyConfig | undefined {
    if (!proxy.enabled) return undefined;
    if (!proxy.host.trim()) {
      throw new Error("Proxy host is required");
    }
    return {
      type: proxy.type,
      host: proxy.host.trim(),
      port: Number(proxy.port) || (proxy.type === "http" ? 8080 : 1080),
      username: proxy.username || undefined,
      password: proxy.password || undefined,
    };
  }

  // Derive a ProxyConfig snapshot for the FingerprintForm so it can probe geo.
  const proxyForForm: ProxyConfig | undefined = proxy.enabled && proxy.host
    ? {
        type: proxy.type,
        host: proxy.host,
        port: Number(proxy.port) || (proxy.type === "http" ? 8080 : 1080),
        username: proxy.username || undefined,
        password: proxy.password || undefined,
      }
    : undefined;

  const canSubmit = name.trim() !== "" && !busy;

  async function submit(autoLaunch: boolean): Promise<void> {
    if (!name.trim()) {
      setError("Name is required");
      setSection("general");
      return;
    }
    let built: ProxyConfig | undefined;
    try {
      built = buildProxy();
    } catch (e) {
      setError((e as Error).message);
      setSection("proxy");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await window.multizen.profiles.create({
        name: name.trim(),
        tags: tagList,
        icon,
        notes: notes.trim() || undefined,
        startUrl: startUrl.trim() || undefined,
        proxy: built,
        fingerprint: fingerprint ?? undefined,
        extensions: extensions.length > 0 ? extensions : undefined,
      });
      onCreated(created.id, autoLaunch);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  // ⌘⏎ / Ctrl+⏎ anywhere in the sheet → Create & launch (matches the hint on
  // the primary button).
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
      e.preventDefault();
      void submit(true);
    }
  }

  return (
    <div className="flex flex-col" style={{ height: SHEET_HEIGHT }} onKeyDown={onKeyDown}>
      <div className="flex flex-1 min-h-0">
        <SectionRail
          section={section}
          onSelect={setSection}
          badges={{ general: name.trim() === "" }}
        />

        {/* Content pane — only this scrolls */}
        <div className="flex-1 min-w-0 overflow-y-auto px-5 py-4">
          {section === "general" && (
            <div className="space-y-3">
              <div className="flex gap-2.5 items-end">
                <Field label="Icon">
                  <EmojiField value={icon} onChange={setIcon} name={name} tags={tagList} />
                </Field>
                <div className="grid grid-cols-2 gap-2.5 flex-1 min-w-0">
                  <Field label="Name">
                    <Input
                      autoFocusHint
                      value={name}
                      onChange={(v) => {
                        setName(v);
                        setError(null); // clear a stale "…required" as they fix it
                      }}
                      placeholder="e.g. acme — sales · west"
                    />
                  </Field>
                  <Field label="Tags">
                    <Input
                      value={tagsRaw}
                      onChange={setTagsRaw}
                      placeholder="comma-separated (optional)"
                    />
                  </Field>
                </div>
              </div>
              <Field label="Notes">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional — what this profile is for"
                  rows={3}
                  className="w-full px-2.5 py-2 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none focus:bg-white/[0.05] transition-colors resize-none"
                  style={{
                    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
                    fontFamily: "var(--font-sans)",
                  }}
                />
              </Field>
            </div>
          )}

          {section === "browser" && (
            <BrowserSection startUrl={startUrl} onStartUrl={setStartUrl} />
          )}

          {section === "proxy" && (
            <div>
              <label className="flex items-center gap-2 text-[12px] text-slate-300 cursor-pointer mb-2.5">
                <input
                  type="checkbox"
                  checked={proxy.enabled}
                  onChange={(e) => setProxy((p) => ({ ...p, enabled: e.target.checked }))}
                  className="w-3.5 h-3.5 rounded accent-purple-500"
                />
                Use proxy
              </label>
              {proxy.enabled && (
                <div className="space-y-2.5">
                  <div className="grid grid-cols-[110px_1fr_90px] gap-2.5">
                    <Field label="Type">
                      <select
                        value={proxy.type}
                        onChange={(e) =>
                          setProxy((p) => ({ ...p, type: e.target.value as "http" | "socks5" }))
                        }
                        className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 outline-none"
                        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                      >
                        <option value="http">HTTP</option>
                        <option value="socks5">SOCKS5</option>
                      </select>
                    </Field>
                    <Field label="Host">
                      <Input
                        value={proxy.host}
                        onChange={(v) => {
                          setProxy((p) => ({ ...p, host: v }));
                          setError(null);
                        }}
                        onPaste={(text) => {
                          const parsed = parseProxyString(text);
                          if (!parsed) return false; // let the default paste fill host
                          setProxy((p) => ({
                            ...p,
                            type: parsed.type ?? p.type,
                            host: parsed.host,
                            port: String(parsed.port),
                            username: parsed.username ?? "",
                            password: parsed.password ?? "",
                          }));
                          return true;
                        }}
                        placeholder="host or host:port:user:pass"
                        mono
                      />
                    </Field>
                    <Field label="Port">
                      <Input
                        value={proxy.port}
                        onChange={(v) => setProxy((p) => ({ ...p, port: v }))}
                        placeholder="8080"
                        mono
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <Field label="Username">
                      <Input
                        value={proxy.username}
                        onChange={(v) => setProxy((p) => ({ ...p, username: v }))}
                        mono
                      />
                    </Field>
                    <Field label="Password">
                      <Input
                        type="password"
                        value={proxy.password}
                        onChange={(v) => setProxy((p) => ({ ...p, password: v }))}
                        mono
                      />
                    </Field>
                  </div>
                  <ProxyTester proxy={proxyForForm} />
                </div>
              )}
            </div>
          )}

          {/* Extensions — staged into the shared store and passed to create. */}
          {section === "extensions" && (
            <ExtensionsSection
              profileId={null}
              staged={extensions}
              onStagedChange={setExtensions}
            />
          )}

          {section === "fingerprint" &&
            (fingerprint ? (
              <FingerprintForm
                fingerprint={fingerprint}
                onChange={setFingerprint}
                proxy={proxyForForm}
              />
            ) : (
              <div className="text-[11px] text-slate-600">Loading preset…</div>
            ))}
        </div>
      </div>

      {/* Action bar — always visible below the rail + content. */}
      <div
        className="shrink-0 flex items-center gap-3 px-5 py-3"
        style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="flex-1 min-w-0 text-[11px] leading-snug text-red-400">
          {error}
        </div>
        <button
          type="button"
          className="btn-ghost px-3 py-[7px] text-[12px] rounded-[9px]"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void submit(false)}
          className="btn-secondary px-3 py-[7px] text-[12px] rounded-[9px]"
        >
          Create
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void submit(true)}
          className="btn-brand px-3 py-[7px] text-[12px] rounded-[9px]"
        >
          {busy ? "…" : "Create & launch"}
          <Kbd variant="on-brand">⌘ ⏎</Kbd>
        </button>
      </div>
    </div>
  );
}
