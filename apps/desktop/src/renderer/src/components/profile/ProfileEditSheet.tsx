import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import type { FingerprintConfig, Profile, ProxyConfig } from "../../types";
import { FingerprintForm } from "./FingerprintForm";
import { ProxyTester } from "./ProxyTester";
import { ExtensionsSection } from "./ExtensionsSection";
import { EmojiField } from "./EmojiField";
import { BrowserSection } from "./BrowserSection";
import { parseProxyString } from "../../lib/parseProxy";

/**
 * Edit existing profile — used inside `<Modal>` so the close gate +
 * dirty-confirm + ESC + backdrop come for free. This is the editing
 * counterpart of `<NewProfileSheet>`; the form layout intentionally
 * mirrors it so creating and editing feel like the same screen.
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

function isDirty(initial: FormState, current: FormState): boolean {
  if (initial.name !== current.name) return true;
  if (initial.notes !== current.notes) return true;
  if (initial.tagsRaw !== current.tagsRaw) return true;
  if (initial.icon !== current.icon) return true;
  if (initial.startUrl !== current.startUrl) return true;
  if (initial.proxyEnabled !== current.proxyEnabled) return true;
  if (initial.proxyType !== current.proxyType) return true;
  if (initial.proxyHost !== current.proxyHost) return true;
  if (initial.proxyPort !== current.proxyPort) return true;
  if (initial.proxyUsername !== current.proxyUsername) return true;
  if (initial.proxyPassword !== current.proxyPassword) return true;
  // Fingerprint is a structured object — JSON-compare is fine here
  // (small size, deterministic field order from generator).
  if (
    JSON.stringify(initial.fingerprint) !== JSON.stringify(current.fingerprint)
  ) {
    return true;
  }
  return false;
}

interface Props {
  profile: Profile;
  onSaved: () => void;
  onCancel: () => void;
  /** Reports dirty state up so the host modal can prompt on close. */
  onDirtyChange?: (dirty: boolean) => void;
}

export function ProfileEditSheet({
  profile,
  onSaved,
  onCancel,
  onDirtyChange,
}: Props): JSX.Element {
  const initialRef = useRef<FormState>(toForm(profile));
  const [form, setForm] = useState<FormState>(() => toForm(profile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-initialize if a different profile is passed in.
  useEffect(() => {
    initialRef.current = toForm(profile);
    setForm(toForm(profile));
  }, [profile]);

  // Dirty-tracking for the host modal's confirm-close gate.
  const lastDirtyRef = useRef(false);
  useEffect(() => {
    const dirty = isDirty(initialRef.current, form);
    if (dirty !== lastDirtyRef.current) {
      lastDirtyRef.current = dirty;
      onDirtyChange?.(dirty);
    }
  }, [form, onDirtyChange]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const proxyForForm: ProxyConfig | undefined = form.proxyEnabled && form.proxyHost
    ? {
        type: form.proxyType,
        host: form.proxyHost,
        port: Number(form.proxyPort) || (form.proxyType === "http" ? 8080 : 1080),
        username: form.proxyUsername || undefined,
        password: form.proxyPassword || undefined,
      }
    : undefined;

  async function save(): Promise<void> {
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const proxy: ProxyConfig | null = form.proxyEnabled
        ? {
            type: form.proxyType,
            host: form.proxyHost,
            port: Number(form.proxyPort) || 0,
            username: form.proxyUsername || undefined,
            password: form.proxyPassword || undefined,
          }
        : null;

      await window.multizen.profiles.update(profile.id, {
        name: form.name,
        notes: form.notes || undefined,
        tags: form.tagsRaw.split(",").map((s) => s.trim()).filter(Boolean),
        // null clears a custom icon (revert to the derived default).
        icon: form.icon ?? null,
        // null → app default start page.
        startUrl: form.startUrl.trim() || null,
        proxy,
        fingerprint: form.fingerprint,
      });
      // Reset dirty AFTER successful save so the host modal closes
      // without re-prompting.
      initialRef.current = form;
      onDirtyChange?.(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-5 pt-4 pb-0">
      {/* General */}
      <Group label="General">
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
              <Input
                autoFocus
                value={form.name}
                onChange={(v) => update("name", v)}
              />
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
        <div className="mt-2.5">
          <Field label="Notes">
            <Textarea
              value={form.notes}
              onChange={(v) => update("notes", v)}
              rows={2}
            />
          </Field>
        </div>
      </Group>

      {/* Browser — start page + default search */}
      <Group label="Browser">
        <BrowserSection
          startUrl={form.startUrl}
          onStartUrl={(v) => update("startUrl", v)}
        />
      </Group>

      {/* Proxy */}
      <Group label="Proxy">
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
                  onChange={(e) =>
                    update("proxyType", e.target.value as "http" | "socks5")
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
                  value={form.proxyHost}
                  onChange={(v) => update("proxyHost", v)}
                  onPaste={(text) => {
                    const parsed = parseProxyString(text);
                    if (!parsed) return false; // let the default paste fill host
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
      </Group>

      {/* Extensions */}
      <Group label="Extensions">
        <ExtensionsSection profileId={profile.id} />
      </Group>

      {/* Fingerprint */}
      <Group label="Fingerprint">
        <FingerprintForm
          fingerprint={form.fingerprint}
          onChange={(fp) => update("fingerprint", fp)}
          proxy={proxyForForm}
        />
      </Group>

      {error && (
        <div
          className="mt-3 px-3 py-2 rounded-lg text-[12px] text-red-400"
          style={{
            background: "rgba(239,68,68,0.06)",
            boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.25)",
          }}
        >
          {error}
        </div>
      )}

      {/* Sticky footer — pinned to bottom of modal scroll viewport so the
          Save button stays in reach even on long forms. */}
      <div
        className="sticky bottom-0 left-0 right-0 -mx-5 mt-5 px-5 py-3 flex items-center justify-end gap-2 z-10"
        style={{
          background: "rgba(15,16,22,0.95)",
          backdropFilter: "blur(8px)",
          borderTop: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <button
          type="button"
          className="btn-ghost px-3 py-[7px] text-[12px] rounded-[9px]"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || !form.name.trim()}
          onClick={() => void save()}
          className="btn-brand px-3 py-[7px] text-[12px] rounded-[9px]"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mt-4 first:mt-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      {children}
    </div>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  mono,
  type,
  autoFocus,
  onPaste,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: "text" | "password";
  autoFocus?: boolean;
  /** Return true to signal the paste was consumed (default browser paste is suppressed). */
  onPaste?: (text: string) => boolean;
}): JSX.Element {
  return (
    <input
      autoFocus={autoFocus}
      type={type ?? "text"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPaste={
        onPaste
          ? (e) => {
              if (onPaste(e.clipboardData.getData("text"))) e.preventDefault();
            }
          : undefined
      }
      placeholder={placeholder}
      className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none focus:bg-white/[0.05] transition-colors"
      style={{
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        fontWeight: mono ? 500 : 400,
      }}
    />
  );
}

function Textarea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}): JSX.Element {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full px-2.5 py-2 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none focus:bg-white/[0.05] transition-colors resize-none"
      style={{
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
        fontFamily: "var(--font-sans)",
      }}
    />
  );
}
