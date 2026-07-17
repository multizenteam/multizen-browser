import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { TopBar } from "./components/screens/TopBar";
import { LeftRail, type Section } from "./components/screens/LeftRail";
import { Constellation } from "./components/profile/Constellation";
import { ProfilesEmptyState } from "./components/profile/EmptyState";
import { NewProfileSheet } from "./components/profile/NewProfileSheet";
import { ProfileEditSheet } from "./components/profile/ProfileEditSheet";
import type { Profile } from "@multizen/types";
import { ActivityDrawer } from "./components/activity/ActivityDrawer";
import { McpPanel } from "./components/mcp/McpPanel";
import { Settings } from "./components/screens/Settings";
import { Confirm, Prompt } from "./components/screens/Confirm";
import { CommandPalette, type CommandAction } from "./components/palette/CommandPalette";
import { FirstRun } from "./components/onboarding/FirstRun";
import { ChromiumBootstrapModal } from "./components/onboarding/ChromiumBootstrapModal";
import { UpdateBanner } from "./components/UpdateBanner";
import { Modal, ConfirmHost, confirm } from "./components/atoms";
import { readPersisted, usePersistedState, writePersisted } from "./lib/persisted";
import type { ActivityEvent, ChromiumStatus, ProfileSummary, SystemInfo } from "./types";

type ModalState =
  | { kind: "none" }
  | { kind: "import-passphrase" }
  | { kind: "export-passphrase"; profileId: string }
  | { kind: "delete-confirm"; profileId: string };

export function App(): JSX.Element {
  // Persisted UI state — survives app restarts under localStorage `multizen.ui.*`.
  const [section, setSection] = usePersistedState<Section>("section", "profiles");
  const [drawerOpen, setDrawerOpen] = usePersistedState<boolean>("drawerOpen", false);

  // Migrate the legacy "activity" section (renamed to "mcp") from localStorage
  // so an existing install doesn't land on a blank screen.
  useEffect(() => {
    if ((section as string) === "activity") setSection("mcp");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ephemeral UI state.
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  // Profiles whose Chromium is winding down (window closed / Stop pressed) but
  // hasn't fully exited — surfaced as a "Terminating…" state on the card.
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  // One live safety-net timer per terminating profile. Keyed by id so a
  // re-terminate (or a relaunch) cancels the *previous* episode's timer
  // instead of letting a stale one fire and clear a genuinely-closing card.
  const closingTimers = useRef<Map<string, number>>(new Map());
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  // Whether the Chromium runtime is ready — used to suppress the update banner
  // while the blocking first-run bootstrap modal is up, so they don't compete.
  const [chromiumReady, setChromiumReady] = useState(false);
  useEffect(() => {
    if (!window.multizen) return;
    const apply = (s: ChromiumStatus): void =>
      setChromiumReady(s.kind === "ready" || s.kind === "dev-system");
    void window.multizen.chromium.status().then(apply);
    return window.multizen.chromium.onStatus(apply);
  }, []);
  // Global toast when the companion "Add to MultiZen" button installs an
  // extension into a running profile (the edit sheet may not be open).
  useEffect(() => {
    if (!window.multizen) return;
    return window.multizen.extensions.onInstalled((e) => {
      showToast(
        e.ok
          ? `Added "${e.extension.name}" — relaunch the profile to apply`
          : `Extension install failed: ${e.error}`,
      );
    });
  }, []);
  // Last-interacted profile id — only used by the command palette's
  // "Export" action, which exports whichever profile the user most
  // recently opened in the edit modal.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function openEditFor(id: string): Promise<void> {
    setSelectedId(id);
    const p = await window.multizen.profiles.get(id);
    if (p) setEditingProfile(p);
  }
  const [showOnboarding, setShowOnboarding] = useState(
    () => !readPersisted<boolean>("onboarded", false),
  );
  const [showSheet, setShowSheet] = useState(false);
  const [sheetDirty, setSheetDirty] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!window.multizen) return;
    const list = await window.multizen.profiles.list();
    setProfiles(list);
  }, []);

  // Initial load + activity stream subscription
  useEffect(() => {
    if (!window.multizen) return;
    void refresh();
    void window.multizen.system.info().then(setInfo);
    void window.multizen.activity.recent().then(setEvents);

    const offEvents = window.multizen.activity.onEvent((e) => {
      setEvents((prev) => {
        const idx = prev.findIndex((x) => x.id === e.id);
        if (idx >= 0) {
          const copy = prev.slice();
          copy[idx] = e;
          return copy;
        }
        return [...prev, e].slice(-500);
      });
      // Refetch profiles when MCP-driven create/launch/close — covers the
      // case where an AI agent created a profile we don't know about.
      if (
        e.tool === "launch_profile" ||
        e.tool === "close_profile" ||
        e.tool === "create_profile"
      ) {
        void refresh();
      }
    });

    // Refetch on ANY running-state change, including the "user closed
    // Chromium window directly" case which doesn't go through MCP at all.
    // Track the transient "closing" phase separately so the card can show
    // "Terminating…" while the process winds down (still in the running map).
    const offRunning = window.multizen.profiles.onRunningChanged((change) => {
      const id = change.profileId;
      const timers = closingTimers.current;
      // Any state transition ends the previous episode's safety timer, so a
      // stale timer can never clear a card that a later episode re-marked.
      const existing = timers.get(id);
      if (existing !== undefined) {
        window.clearTimeout(existing);
        timers.delete(id);
      }
      setClosingIds((prev) => {
        const next = new Set(prev);
        if (change.kind === "closing") next.add(id);
        else next.delete(id); // launched / closed
        return next;
      });
      if (change.kind === "closing") {
        // Safety net: if a terminal (closed/launched) event is ever missed,
        // don't strand the card on "Terminating…" — self-clear after 10s.
        const timer = window.setTimeout(() => {
          // Guard against a superseding episode: if a newer "closing" replaced
          // this timer between it elapsing and its callback running, do nothing.
          if (timers.get(id) !== timer) return;
          timers.delete(id);
          setClosingIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }, 10_000);
        timers.set(id, timer);
      }
      void refresh();
    });

    // Background proxy-country backfill emits this as each probe lands —
    // refresh so the flag chip updates without the user touching anything.
    const offProxyCountry = window.multizen.profiles.onProxyCountryUpdated(() => {
      void refresh();
    });

    return () => {
      offEvents();
      offRunning();
      offProxyCountry();
      closingTimers.current.forEach((t) => window.clearTimeout(t));
      closingTimers.current.clear();
    };
  }, [refresh]);

  // Keyboard shortcuts: ⌘K palette, ⌘N new profile, ⌘1/2/, sections,
  // ⌘⇧A drawer, esc closes overlays.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (meta && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setShowSheet(true);
        return;
      }
      if (meta && e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setDrawerOpen((v) => !v);
        return;
      }
      if (meta && e.key === "1") {
        e.preventDefault();
        setSection("profiles");
        return;
      }
      if (meta && e.key === "2") {
        e.preventDefault();
        setSection("mcp");
        return;
      }
      if (meta && e.key === ",") {
        e.preventDefault();
        setSection("settings");
        return;
      }
      // ESC: <Modal> handles its own ESC (with dirty-form confirm); no
      // other UI listens for ESC at the app level.
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSheet]);

  function showToast(msg: string): void {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  }

  function dismissOnboarding(): void {
    writePersisted("onboarded", true);
    setShowOnboarding(false);
  }

  async function onboardCreate(name: string, tags: string[]): Promise<void> {
    await window.multizen.profiles.create({ name, tags });
    dismissOnboarding();
    await refresh();
  }

  async function launchProfile(id: string): Promise<void> {
    try {
      await window.multizen.profiles.launch(id);
    } catch (e) {
      showToast(`Launch failed: ${(e as Error).message}`);
    }
    await refresh();
  }

  async function closeProfile(id: string): Promise<void> {
    // close() may reject if graceful shutdown throws, but the driver's
    // finally still emits "closed" (which drives its own refresh), so a
    // rejection here is cosmetic — swallow it to avoid an unhandled rejection.
    try {
      await window.multizen.profiles.close(id);
    } catch {
      /* driver emits "closed" regardless; state self-heals */
    }
    await refresh();
  }

  async function importProfile(passphrase: string): Promise<void> {
    setModal({ kind: "none" });
    const result = await window.multizen.profiles.importArchive(passphrase);
    if (!result.ok) {
      if (result.reason !== "cancelled") showToast(`Import failed: ${result.reason}`);
      return;
    }
    await refresh();
  }

  async function exportProfile(profileId: string, passphrase: string): Promise<void> {
    setModal({ kind: "none" });
    if (passphrase.length < 8) {
      showToast("Passphrase must be at least 8 characters");
      return;
    }
    const result = await window.multizen.profiles.exportArchive(profileId, passphrase);
    if (result.ok) {
      const file = result.path.split("/").slice(-1)[0];
      showToast(`Exported to ${file}`);
    } else if (result.reason !== "cancelled") {
      showToast(`Export failed: ${result.reason}`);
    }
  }

  async function deleteProfile(id: string): Promise<void> {
    setModal({ kind: "none" });
    await window.multizen.profiles.close(id).catch(() => {});
    await window.multizen.profiles.delete(id);
    if (selectedId === id) setSelectedId(null);
    await refresh();
  }

  function handleCommand(a: CommandAction): void {
    switch (a.kind) {
      case "launch":
        void launchProfile(a.profileId);
        break;
      case "open":
        void openEditFor(a.profileId);
        break;
      case "create":
        setShowSheet(true);
        break;
      case "import":
        setModal({ kind: "import-passphrase" });
        break;
      case "export":
        if (selectedId) setModal({ kind: "export-passphrase", profileId: selectedId });
        break;
      case "settings":
        setSection("settings");
        break;
      case "section":
        setSection(a.id);
        break;
    }
  }

  const runningCount = profiles.filter((p) => p.isRunning).length;

  if (showOnboarding && window.multizen) {
    return <FirstRun onCreate={onboardCreate} />;
  }

  return (
    <div className="h-screen flex flex-col">
      <TopBar
        totalCount={profiles.length}
        runningCount={runningCount}
        mcpUrl={info?.mcpHttpUrl ?? null}
        onCmdK={() => setPaletteOpen(true)}
        onSettings={() => setSection("settings")}
      />

      <UpdateBanner suppressed={!chromiumReady} />

      <div className="flex-1 flex min-h-0">
        <LeftRail active={section} onChange={setSection} onCmdK={() => setPaletteOpen(true)} />

        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {!window.multizen && (
            <div
              className="m-6 px-4 py-3 rounded-lg text-sm text-red-300"
              style={{ background: "rgba(239,68,68,0.06)", boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.25)" }}
            >
              Preload bridge missing — <code>window.multizen</code> is undefined. Open DevTools for details.
            </div>
          )}

          {section === "profiles" && (
            <>
              <Modal
                open={showSheet}
                title="New profile"
                subtitle="Cookies, login state, and fingerprint live in this profile only."
                width={720}
                onClose={() => {
                  setShowSheet(false);
                  setSheetDirty(false);
                }}
                confirmClose={async () => {
                  if (!sheetDirty) return true;
                  return confirm({
                    title: "Discard your changes?",
                    body: "You haven't created the profile yet. Closing will lose what you've entered.",
                    confirmLabel: "Discard",
                    destructive: true,
                  });
                }}
              >
                <NewProfileSheet
                  onCancel={() => {
                    setShowSheet(false);
                    setSheetDirty(false);
                  }}
                  onDirtyChange={setSheetDirty}
                  onCreated={async (id, autoLaunch) => {
                    setShowSheet(false);
                    setSheetDirty(false);
                    await refresh();
                    if (autoLaunch) {
                      await launchProfile(id);
                    }
                  }}
                />
              </Modal>
              {profiles.length === 0 ? (
                <ProfilesEmptyState onCreate={() => setShowSheet(true)} />
              ) : (
                <Constellation
                  profiles={profiles}
                  recentEvents={events}
                  closingIds={closingIds}
                  onSelect={openEditFor}
                  onCreate={() => setShowSheet(true)}
                  onLaunch={launchProfile}
                  onStop={closeProfile}
                  onExport={(id) => setModal({ kind: "export-passphrase", profileId: id })}
                  onDelete={(id) => setModal({ kind: "delete-confirm", profileId: id })}
                />
              )}
            </>
          )}

          {section === "mcp" && (
            <McpPanel
              events={events}
              profiles={profiles}
              mcpUrl={info?.mcpHttpUrl ?? null}
              mcpToken={info?.mcpAuthToken ?? null}
            />
          )}

          {section === "settings" && <Settings onImport={() => setModal({ kind: "import-passphrase" })} />}
        </div>

      </div>

      {/* Edit profile — autosaves as you go (Discord-settings style), so no
          Save button and no discard gate; the sheet flushes a pending change
          on close. */}
      <Modal
        open={editingProfile !== null}
        title={editingProfile ? `Edit ${editingProfile.name}` : "Edit profile"}
        subtitle="Changes autosave and apply on the next profile launch."
        width={720}
        onClose={() => {
          setEditingProfile(null);
          void refresh();
        }}
      >
        {editingProfile && (
          <ProfileEditSheet profile={editingProfile} onSaved={() => void refresh()} />
        )}
      </Modal>

      {section !== "mcp" && (
        <ActivityDrawer
          open={drawerOpen}
          events={events}
          profiles={profiles}
          onToggle={() => setDrawerOpen((v) => !v)}
        />
      )}

      <ChromiumBootstrapModal />

      {/* Mount once at app root so confirm() works from anywhere. */}
      <ConfirmHost />

      <CommandPalette
        open={paletteOpen}
        profiles={profiles}
        onClose={() => setPaletteOpen(false)}
        onAction={handleCommand}
      />

      <Prompt
        open={modal.kind === "import-passphrase"}
        title="Import profile archive"
        description="Choose a .mzar file. Provide the passphrase used at export time."
        label="Passphrase"
        inputType="password"
        placeholder="Passphrase"
        confirmLabel="Choose file & import"
        onSubmit={importProfile}
        onCancel={() => setModal({ kind: "none" })}
      />

      <Prompt
        open={modal.kind === "export-passphrase"}
        title="Export profile archive"
        description="Choose a passphrase to encrypt the archive. You'll need it to import this profile elsewhere. Minimum 8 characters."
        label="New passphrase"
        inputType="password"
        placeholder="At least 8 characters"
        confirmLabel="Encrypt & save…"
        onSubmit={(p) => {
          if (modal.kind === "export-passphrase") {
            return exportProfile(modal.profileId, p);
          }
          return Promise.resolve();
        }}
        onCancel={() => setModal({ kind: "none" })}
      />

      <Confirm
        open={modal.kind === "delete-confirm"}
        title="Delete this profile?"
        description="Cookies, login state, and on-disk data will be erased permanently. This cannot be undone."
        confirmLabel="Yes, delete"
        destructive
        onConfirm={() => {
          if (modal.kind === "delete-confirm") void deleteProfile(modal.profileId);
        }}
        onCancel={() => setModal({ kind: "none" })}
      />

      {toast && (
        <div
          className="fixed right-6 px-4 py-3 rounded-lg text-sm"
          style={{
            bottom: 56,
            background: "rgba(15,16,22,0.92)",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08), 0 20px 60px rgba(0,0,0,0.5)",
            backdropFilter: "blur(20px)",
            animation: "mz-slide-up 200ms ease-out",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
