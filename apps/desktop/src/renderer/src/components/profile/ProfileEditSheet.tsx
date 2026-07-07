import { useEffect, useRef, useState, type JSX } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import type { FingerprintConfig, Profile, ProxyConfig, UpdateProfileInput } from "../../types";
import { FingerprintForm } from "./FingerprintForm";
import { ProxyTester } from "./ProxyTester";
import { ExtensionsSection } from "./ExtensionsSection";
import { EmojiField } from "./EmojiField";
import { BrowserSection } from "./BrowserSection";
import { parseProxyString } from "../../lib/parseProxy";
import {
  Field,
  Input,
  SHEET_HEIGHT,
  SectionRail,
  Textarea,
  type SectionId,
} from "./profileSheetKit";

/**
 * Edit an existing profile. Discord-settings-style: a left rail switches
 * sections, only the content pane scrolls, and edits AUTOSAVE (debounced) so
 * there is no Save button and no discard prompt. A pending save is flushed on
 * close so the last keystroke is never lost. Extensions save themselves live
 * (their own IPC), so they sit outside the form's autosave.
 */

interface FormState {
  name: string;
  notes: string;
  tagsRaw: string;
  /** Custom emoji avatar; undefined = auto (classifier-derived default). */
  icon: string | undefined;
  /** Start page ("" = app default). */
  startUrl: string;
  proxyEnabled: boolean;
  proxyType: "http" | "socks5";
  proxyHost: string;
  proxyPort: string;
  proxyUsername: string;
  proxyPassword: string;
  fingerprint: FingerprintConfig;
}

function toForm(p: Profile): FormState {
  return {
    name: p.name,
    notes: p.notes ?? "",
    tagsRaw: p.tags.join(", "),
    icon: p.icon,
    startUrl: p.startUrl ?? "",
    proxyEnabled: !!p.proxy,
    proxyType: p.proxy?.type ?? "http",
    proxyHost: p.proxy?.host ?? "",
    proxyPort: p.proxy?.port ? String(p.proxy.port) : "",
    proxyUsername: p.proxy?.username ?? "",
    proxyPassword: p.proxy?.password ?? "",
    fingerprint: p.fingerprint,
  };
}

/** null → cannot save (with reason); otherwise the field is fine. */
function validate(f: FormState): string | null {
  if (!f.name.trim()) return "Name is required";
  if (f.proxyEnabled && !f.proxyHost.trim()) return "Proxy host is required";
  return null;
}

function toPatch(f: FormState): UpdateProfileInput {
  const proxy: ProxyConfig | null = f.proxyEnabled
    ? {
        type: f.proxyType,
        host: f.proxyHost.trim(),
        port: Number(f.proxyPort) || (f.proxyType === "http" ? 8080 : 1080),
        username: f.proxyUsername || undefined,
        password: f.proxyPassword || undefined,
      }
    : null;
  return {
    name: f.name.trim(),
    notes: f.notes || undefined,
    tags: f.tagsRaw.split(",").map((s) => s.trim()).filter(Boolean),
    icon: f.icon ?? null, // null clears a custom icon (revert to derived default)
    startUrl: f.startUrl.trim() || null, // null → app default start page
    proxy,
    fingerprint: f.fingerprint,
  };
}

type SaveStatus =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "error"; message: string };

const AUTOSAVE_MS = 600;

interface Props {
  profile: Profile;
  /** Fired after each successful autosave so the host can refresh the list. */
  onSaved?: () => void;
}

export function ProfileEditSheet({ profile, onSaved }: Props): JSX.Element {
  const [section, setSection] = useState<SectionId>("general");
  const [form, setForm] = useState<FormState>(() => toForm(profile));
  const [status, setStatus] = useState<SaveStatus>({ kind: "saved" });

  // JSON of the last-persisted form; edits that match it don't trigger a save.
  const savedRef = useRef<string>(JSON.stringify(toForm(profile)));
  // Always-current form + profile id for the flush-on-unmount cleanup.
  const latestRef = useRef<{ form: FormState; id: string }>({ form, id: profile.id });
  latestRef.current = { form, id: profile.id };
  const timerRef = useRef<number | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // Re-initialize when a different profile is opened.
  useEffect(() => {
    const f = toForm(profile);
    setForm(f);
    savedRef.current = JSON.stringify(f);
    setStatus({ kind: "saved" });
    setSection("general");
  }, [profile]);

  async function persist(f: FormState): Promise<void> {
    setStatus({ kind: "saving" });
    try {
      await window.multizen.profiles.update(profile.id, toPatch(f));
      savedRef.current = JSON.stringify(f);
      setStatus({ kind: "saved" });
      onSavedRef.current?.();
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    }
  }

  // Debounced autosave: fire AUTOSAVE_MS after the last change, only when the
  // form actually changed and is valid.
  useEffect(() => {
    if (JSON.stringify(form) === savedRef.current) return; // nothing new
    const invalid = validate(form);
    if (invalid) {
      setStatus({ kind: "error", message: invalid });
      return;
    }
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void persist(form), AUTOSAVE_MS);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
    // persist is stable enough; we intentionally depend only on `form`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  // Flush a pending, valid change on unmount so closing never drops the last
  // edit. Chain onSaved so the profile list re-reads AFTER the write lands —
  // otherwise a close-within-debounce leaves the card showing the stale value.
  useEffect(() => {
    return () => {
      const { form: f, id } = latestRef.current;
      if (JSON.stringify(f) !== savedRef.current && !validate(f)) {
        void window.multizen.profiles
          .update(id, toPatch(f))
          .then(() => onSavedRef.current?.())
          .catch(() => {
            // Component is gone; nothing to surface. Swallow to avoid an
            // unhandled rejection warning.
          });
      }
    };
  }, []);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const proxyForForm: ProxyConfig | undefined =
    form.proxyEnabled && form.proxyHost
      ? {
          type: form.proxyType,
          host: form.proxyHost,
          port: Number(form.proxyPort) || (form.proxyType === "http" ? 8080 : 1080),
          username: form.proxyUsername || undefined,
          password: form.proxyPassword || undefined,
        }
      : undefined;

  return (
    <div className="flex" style={{ height: SHEET_HEIGHT }}>
      <SectionRail
        section={section}
        onSelect={setSection}
        badges={{ general: !form.name.trim() }}
        footer={<StatusPill status={status} />}
      />

      {/* Content pane — only this scrolls */}
      <div className="flex-1 min-w-0 overflow-y-auto px-5 py-4">
        {section === "general" && (
          <div className="space-y-3">
            <div className="flex gap-2.5 items-end">
              <Field label="Icon">
                <EmojiField
                  value={form.icon}
                  onChange={(v) => update("icon", v)}
                  name={form.name}
                  tags={form.tagsRaw.split(",").map((s) => s.trim()).filter(Boolean)}
                  id={profile.id}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2.5 flex-1 min-w-0">
                <Field label="Name">
                  <Input autoFocusHint value={form.name} onChange={(v) => update("name", v)} />
                </Field>
                <Field label="Tags">
                  <Input
                    value={form.tagsRaw}
                    onChange={(v) => update("tagsRaw", v)}
                    placeholder="comma-separated"
                  />
                </Field>
              </div>
            </div>
            <Field label="Notes">
              <Textarea value={form.notes} onChange={(v) => update("notes", v)} rows={3} />
            </Field>
          </div>
        )}

        {section === "browser" && (
          <BrowserSection startUrl={form.startUrl} onStartUrl={(v) => update("startUrl", v)} />
        )}

        {section === "proxy" && (
          <div>
            <label className="flex items-center gap-2 text-[12px] text-slate-300 cursor-pointer mb-2.5">
              <input
                type="checkbox"
                checked={form.proxyEnabled}
                onChange={(e) => update("proxyEnabled", e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-purple-500"
              />
              Use proxy
            </label>
            {form.proxyEnabled && (
              <div className="space-y-2.5">
                <div className="grid grid-cols-[110px_1fr_90px] gap-2.5">
                  <Field label="Type">
                    <select
                      value={form.proxyType}
                      onChange={(e) => update("proxyType", e.target.value as "http" | "socks5")}
                      className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 outline-none"
                      style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                    >
                      <option value="http">HTTP</option>
                      <option value="socks5">SOCKS5</option>
                    </select>
                  </Field>
                  <Field label="Host">
                    <Input
                      value={form.proxyHost}
                      onChange={(v) => update("proxyHost", v)}
                      onPaste={(text) => {
                        const parsed = parseProxyString(text);
                        if (!parsed) return false;
                        setForm((f) => ({
                          ...f,
                          proxyType: parsed.type ?? f.proxyType,
                          proxyHost: parsed.host,
                          proxyPort: String(parsed.port),
                          proxyUsername: parsed.username ?? "",
                          proxyPassword: parsed.password ?? "",
                        }));
                        return true;
                      }}
                      placeholder="host or host:port:user:pass"
                      mono
                    />
                  </Field>
                  <Field label="Port">
                    <Input
                      value={form.proxyPort}
                      onChange={(v) => update("proxyPort", v)}
                      placeholder="8080"
                      mono
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label="Username">
                    <Input
                      value={form.proxyUsername}
                      onChange={(v) => update("proxyUsername", v)}
                      mono
                    />
                  </Field>
                  <Field label="Password">
                    <Input
                      type="password"
                      value={form.proxyPassword}
                      onChange={(v) => update("proxyPassword", v)}
                      mono
                    />
                  </Field>
                </div>
                <ProxyTester proxy={proxyForForm} profileId={profile.id} />
              </div>
            )}
          </div>
        )}

        {section === "extensions" && <ExtensionsSection profileId={profile.id} />}

        {section === "fingerprint" && (
          <FingerprintForm
            fingerprint={form.fingerprint}
            onChange={(fp) => update("fingerprint", fp)}
            proxy={proxyForForm}
          />
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: SaveStatus }): JSX.Element {
  if (status.kind === "saving") {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
        <Loader2 size={11} className="animate-spin" /> Saving…
      </div>
    );
  }
  if (status.kind === "error") {
    return (
      <div className="flex items-start gap-1.5 text-[11px] text-amber-400/90 leading-snug">
        <TriangleAlert size={11} className="shrink-0 mt-[1px]" />
        <span>{status.message}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
      <Check size={11} className="text-emerald-400/80" /> All changes saved
    </div>
  );
}
