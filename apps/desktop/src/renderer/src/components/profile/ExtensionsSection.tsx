import { useEffect, useState, type Dispatch, type JSX, type SetStateAction } from "react";
import { Blocks, LayoutGrid, Library, Loader2, Plus, Trash2 } from "lucide-react";
import type { ExtensionConfig } from "../../types";
import { ExtensionCatalog } from "./ExtensionCatalog";
import type { CatalogExtension } from "../../data/extensionCatalog";

/**
 * Per-profile extensions manager, shared by the create + edit sheets.
 *
 * Two modes:
 *  - Live (edit, or any saved profile): `profileId` is set → installs/toggles/
 *    removes hit the backend for that profile immediately.
 *  - Staging (create): `profileId` is null and `onStagedChange` is provided →
 *    the section operates on an in-memory list. Installs unpack into the shared
 *    store (via `prepare*`, no profile yet) and the parent passes the staged
 *    list to `profiles.create({ extensions })`. "Attach existing" pulls refs
 *    already in the store from other profiles with no download.
 */
export function ExtensionsSection({
  profileId,
  staged,
  onStagedChange,
}: {
  profileId: string | null;
  staged?: ExtensionConfig[];
  // A React setter (supports functional updates) so concurrent staging installs
  // compose against the latest list rather than a stale closure snapshot.
  onStagedChange?: Dispatch<SetStateAction<ExtensionConfig[]>>;
}): JSX.Element {
  if (!profileId) {
    if (onStagedChange) {
      return <StagingExtensions staged={staged ?? []} onChange={onStagedChange} />;
    }
    return (
      <div className="text-[12px] text-slate-500 leading-relaxed">
        Save the profile first — then you can add extensions (.crx / .zip / folder, or by
        Chrome Web Store link) and they&apos;ll load in this profile only.
      </div>
    );
  }
  return <LiveExtensions profileId={profileId} />;
}

// ─── Live mode (edit / saved profile) ─────────────────────────────────────

function LiveExtensions({ profileId }: { profileId: string }): JSX.Element {
  const [items, setItems] = useState<ExtensionConfig[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCatalog, setShowCatalog] = useState(false);
  const [catalogBusyId, setCatalogBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!window.multizen) return;
    void window.multizen.extensions.list(profileId).then(setItems);
    // A companion "Add to MultiZen" install (while editing a running profile)
    // pushes here — refresh the list.
    return window.multizen.extensions.onInstalled((e) => {
      if (e.profileId === profileId) {
        void window.multizen.extensions.list(profileId).then(setItems);
        if (!e.ok) setError(e.error);
      }
    });
  }, [profileId]);

  async function run(fn: () => Promise<ExtensionConfig[]>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setItems(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function installFromCatalog(ext: CatalogExtension): Promise<void> {
    setCatalogBusyId(ext.id);
    setError(null);
    try {
      setItems(await window.multizen.extensions.addFromWebStore(profileId, ext.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCatalogBusyId(null);
    }
  }

  return (
    <div className="space-y-2.5">
      {items.length > 0 && (
        <div className="space-y-1.5">
          {items.map((ext) => (
            <ExtRow
              key={ext.id}
              ext={ext}
              onToggle={(enabled) =>
                void run(() => window.multizen.extensions.toggle(profileId, ext.id, enabled))
              }
              onRemove={() => void run(() => window.multizen.extensions.remove(profileId, ext.id))}
            />
          ))}
        </div>
      )}

      <AddRow
        url={url}
        onUrl={setUrl}
        busy={busy}
        onAddWebStore={() =>
          void run(async () => {
            const next = await window.multizen.extensions.addFromWebStore(profileId, url.trim());
            setUrl("");
            return next;
          })
        }
        onAddFile={() => void run(() => window.multizen.extensions.addFromFile(profileId))}
        onAddFolder={() => void run(() => window.multizen.extensions.addFromFolder(profileId))}
      />

      <CatalogToggle open={showCatalog} onToggle={() => setShowCatalog((v) => !v)} />
      {showCatalog && (
        <ExtensionCatalog
          installedIds={new Set(items.map((e) => e.id))}
          busyId={catalogBusyId}
          onInstall={(ext) => void installFromCatalog(ext)}
        />
      )}

      <div className="text-[11px] text-slate-600 leading-relaxed">
        Or open the Chrome Web Store inside this profile and click <b>Add to MultiZen</b>.
        Changes apply on the next launch.
      </div>

      {error && <ErrorBox message={error} />}
    </div>
  );
}

// ─── Staging mode (create sheet, no profile id yet) ───────────────────────

function StagingExtensions({
  staged,
  onChange,
}: {
  staged: ExtensionConfig[];
  onChange: Dispatch<SetStateAction<ExtensionConfig[]>>;
}): JSX.Element {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAttach, setShowAttach] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [catalogBusyId, setCatalogBusyId] = useState<string | null>(null);
  const [available, setAvailable] = useState<ExtensionConfig[] | null>(null);

  const stagedIds = new Set(staged.map((e) => e.id));

  // Upsert by id so re-adding the same extension doesn't create a duplicate row.
  // Functional update: a slow prepareFromWebStore can overlap another install,
  // so compose against the latest list, not this render's `staged` snapshot.
  function upsert(cfg: ExtensionConfig): void {
    onChange((prev) => [...prev.filter((e) => e.id !== cfg.id), cfg]);
  }

  async function run(fn: () => Promise<ExtensionConfig | null>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const cfg = await fn();
      if (cfg) upsert(cfg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openAttach(): Promise<void> {
    setShowAttach((v) => !v);
    if (available === null) {
      try {
        setAvailable(await window.multizen.extensions.storeEntries());
      } catch {
        setAvailable([]);
      }
    }
  }

  async function installFromCatalog(ext: CatalogExtension): Promise<void> {
    setCatalogBusyId(ext.id);
    setError(null);
    try {
      upsert(await window.multizen.extensions.prepareFromWebStore(ext.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCatalogBusyId(null);
    }
  }

  const attachable = (available ?? []).filter((e) => !stagedIds.has(e.id));

  return (
    <div className="space-y-2.5">
      {staged.length > 0 && (
        <div className="space-y-1.5">
          {staged.map((ext) => (
            <ExtRow
              key={ext.id}
              ext={ext}
              onToggle={(enabled) =>
                onChange((prev) =>
                  prev.map((e) => (e.id === ext.id ? { ...e, enabled } : e)),
                )
              }
              onRemove={() => onChange((prev) => prev.filter((e) => e.id !== ext.id))}
            />
          ))}
        </div>
      )}

      <AddRow
        url={url}
        onUrl={setUrl}
        busy={busy}
        onAddWebStore={() =>
          void run(async () => {
            const cfg = await window.multizen.extensions.prepareFromWebStore(url.trim());
            setUrl("");
            return cfg;
          })
        }
        onAddFile={() => void run(() => window.multizen.extensions.prepareFromFile())}
        onAddFolder={() => void run(() => window.multizen.extensions.prepareFromFolder())}
      />

      <CatalogToggle open={showCatalog} onToggle={() => setShowCatalog((v) => !v)} />
      {showCatalog && (
        <ExtensionCatalog
          installedIds={stagedIds}
          busyId={catalogBusyId}
          onInstall={(ext) => void installFromCatalog(ext)}
        />
      )}

      {/* Attach an extension already unpacked by another profile — no download,
          no data (the new profile starts logged-out/fresh). */}
      <button
        type="button"
        onClick={() => void openAttach()}
        className="btn-ghost px-3 py-[7px] text-[12px] rounded-[9px] inline-flex items-center gap-1.5"
      >
        <Library size={12} />
        {showAttach ? "Hide your extensions" : "Attach from your profiles"}
      </button>

      {showAttach && (
        <div className="space-y-1.5">
          {available === null ? (
            <div className="text-[11px] text-slate-600 flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" /> Loading…
            </div>
          ) : attachable.length === 0 ? (
            <div className="text-[11px] text-slate-600 leading-relaxed">
              No other extensions in your library yet. Add one above and it becomes attachable
              to future profiles.
            </div>
          ) : (
            attachable.map((ext) => (
              <button
                key={ext.id}
                type="button"
                onClick={() => upsert({ ...ext, enabled: true })}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors hover:bg-white/[0.05]"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
                }}
              >
                <Blocks size={14} className="text-purple-300 shrink-0" />
                <span className="flex-1 text-[12px] text-slate-200 truncate">{ext.name}</span>
                <Plus size={13} className="text-slate-500 shrink-0" />
              </button>
            ))
          )}
        </div>
      )}

      <div className="text-[11px] text-slate-600 leading-relaxed">
        Extensions load on first launch. Login/state is not copied — attached extensions start
        fresh in this profile.
      </div>

      {error && <ErrorBox message={error} />}
    </div>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────────

function ExtRow({
  ext,
  onToggle,
  onRemove,
}: {
  ext: ExtensionConfig;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg"
      style={{
        background: "rgba(255,255,255,0.03)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
      }}
    >
      <Blocks size={14} className="text-purple-300 shrink-0" />
      <span className="flex-1 text-[12px] text-slate-200 truncate">{ext.name}</span>
      <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
        <input
          type="checkbox"
          checked={ext.enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="w-3.5 h-3.5 rounded accent-purple-500"
        />
        on
      </label>
      <button
        type="button"
        aria-label="Remove"
        onClick={onRemove}
        className="text-slate-500 hover:text-red-400 transition-colors"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function AddRow({
  url,
  onUrl,
  busy,
  onAddWebStore,
  onAddFile,
  onAddFolder,
}: {
  url: string;
  onUrl: (v: string) => void;
  busy: boolean;
  onAddWebStore: () => void;
  onAddFile: () => void;
  onAddFolder: () => void;
}): JSX.Element {
  return (
    <>
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => onUrl(e.target.value)}
          placeholder="Chrome Web Store URL or extension ID"
          className="flex-1 px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none focus:bg-white/[0.05] transition-colors"
          style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
        />
        <button
          type="button"
          disabled={busy || !url.trim()}
          onClick={onAddWebStore}
          className="btn-secondary px-3 py-[7px] text-[12px] rounded-[9px] whitespace-nowrap inline-flex items-center gap-1.5"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          Add
        </button>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onAddFile}
          className="btn-ghost px-3 py-[7px] text-[12px] rounded-[9px]"
        >
          Add .crx / .zip…
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onAddFolder}
          className="btn-ghost px-3 py-[7px] text-[12px] rounded-[9px]"
        >
          Add folder…
        </button>
      </div>
    </>
  );
}

function CatalogToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="btn-ghost px-3 py-[7px] text-[12px] rounded-[9px] inline-flex items-center gap-1.5"
    >
      <LayoutGrid size={12} />
      {open ? "Hide catalog" : "Browse catalog"}
    </button>
  );
}

function ErrorBox({ message }: { message: string }): JSX.Element {
  return (
    <div
      className="px-3 py-2 rounded-lg text-[12px] text-red-400"
      style={{
        background: "rgba(239,68,68,0.06)",
        boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.25)",
      }}
    >
      {message}
    </div>
  );
}
