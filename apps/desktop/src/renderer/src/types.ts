import type {
  CreateProfileInput,
  ProfileId,
  ProfileSummary,
  Profile,
  ProxyConfig,
  FingerprintConfig,
  UpdateProfileInput,
  LaunchedProfile,
  ChromiumStatus,
  DeviceFamily,
  UpdateStatus,
  ExtensionConfig,
} from "@multizen/types";

/** Payload for the `extensions:installed` push (companion "Add to MultiZen"). */
export type ExtensionInstalledEvent =
  | { ok: true; profileId: string; extension: ExtensionConfig }
  | { ok: false; profileId: string; error: string };

export interface DeviceCatalogEntry {
  family: DeviceFamily;
  label: string;
  screens: ReadonlyArray<{ width: number; height: number; label: string }>;
}
export interface LocaleCatalogEntry {
  id: string;
  label: string;
  locale: string;
  country: string;
  timezones: ReadonlyArray<string>;
}
export interface FingerprintReconcilePatch {
  device?: DeviceFamily;
  localeId?: string;
  screen?: { width: number; height: number };
  timezone?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
}
export interface ProxyGeoResult {
  country: string;
  countryName: string;
  timezone: string;
  city: string;
  ip: string;
}
import type { ActivityEvent } from "@multizen/mcp-server";
import type { AppSettings } from "@multizen/settings-store";

export interface SystemInfo {
  mcpHttpUrl: string | null;
  mcpAuthToken: string | null;
  appVersion: string;
  platform: string;
}

export type RunningStateChange =
  | { kind: "launched"; profileId: ProfileId }
  | { kind: "closing"; profileId: ProfileId }
  | { kind: "closed"; profileId: ProfileId; reason: "user-close" | "external-exit" };

export interface MultizenApi {
  profiles: {
    list: () => Promise<ProfileSummary[]>;
    get: (id: ProfileId) => Promise<Profile | null>;
    create: (input: CreateProfileInput) => Promise<Profile>;
    update: (id: ProfileId, patch: UpdateProfileInput) => Promise<Profile>;
    delete: (id: ProfileId) => Promise<void>;
    launch: (id: ProfileId) => Promise<LaunchedProfile>;
    close: (id: ProfileId) => Promise<void>;
    exportArchive: (
      id: ProfileId,
      passphrase: string,
    ) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
    importArchive: (
      passphrase: string,
    ) => Promise<{ ok: true; id: ProfileId } | { ok: false; reason: string }>;
    onRunningChanged: (cb: (change: RunningStateChange) => void) => () => void;
    onProxyCountryUpdated: (
      cb: (update: { id: string; country: string }) => void,
    ) => () => void;
  };
  settings: {
    get: () => Promise<AppSettings>;
    update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  };
  activity: {
    recent: () => Promise<ActivityEvent[]>;
    onEvent: (cb: (e: ActivityEvent) => void) => () => void;
  };
  system: {
    info: () => Promise<SystemInfo>;
  };
  chromium: {
    status: () => Promise<ChromiumStatus>;
    retry: () => Promise<ChromiumStatus>;
    onStatus: (cb: (s: ChromiumStatus) => void) => () => void;
  };
  extensions: {
    list: (profileId: string) => Promise<ExtensionConfig[]>;
    addFromFile: (profileId: string) => Promise<ExtensionConfig[]>;
    addFromFolder: (profileId: string) => Promise<ExtensionConfig[]>;
    addFromWebStore: (profileId: string, urlOrId: string) => Promise<ExtensionConfig[]>;
    remove: (profileId: string, extId: string) => Promise<ExtensionConfig[]>;
    toggle: (profileId: string, extId: string, enabled: boolean) => Promise<ExtensionConfig[]>;
    /** Staging (create sheet, no profile id yet). */
    storeEntries: () => Promise<ExtensionConfig[]>;
    prepareFromWebStore: (urlOrId: string) => Promise<ExtensionConfig>;
    prepareFromFile: () => Promise<ExtensionConfig | null>;
    prepareFromFolder: () => Promise<ExtensionConfig | null>;
    /** Real icon from the extension's manifest, as a data URI (or null). */
    icon: (ext: ExtensionConfig, profileId: string | null) => Promise<string | null>;
    onInstalled: (cb: (e: ExtensionInstalledEvent) => void) => () => void;
  };
  update: {
    status: () => Promise<UpdateStatus>;
    lastChecked: () => Promise<number>;
    check: () => Promise<UpdateStatus>;
    install: () => Promise<void>;
    download: (version: string) => Promise<void>;
    onStatus: (cb: (s: UpdateStatus) => void) => () => void;
  };
  fingerprint: {
    generate: () => Promise<FingerprintConfig>;
    devices: () => Promise<ReadonlyArray<DeviceCatalogEntry>>;
    locales: () => Promise<ReadonlyArray<LocaleCatalogEntry>>;
    reconcile: (
      current: FingerprintConfig,
      patch: FingerprintReconcilePatch,
    ) => Promise<FingerprintConfig>;
    localeForCountry: (cc: string) => Promise<string | null>;
  };
  proxy: {
    detectGeo: (
      proxy: ProxyConfig,
      profileId?: string,
    ) => Promise<{ ok: true; geo: ProxyGeoResult } | { ok: false; error: string }>;
  };
}

declare global {
  interface Window {
    multizen: MultizenApi;
  }
}

export type {
  ActivityEvent,
  AppSettings,
  Profile,
  ProfileSummary,
  ProxyConfig,
  FingerprintConfig,
  LaunchedProfile,
  ChromiumStatus,
  DeviceFamily,
  UpdateStatus,
  ExtensionConfig,
  UpdateProfileInput,
};
