import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Globe2, Plus, X } from "lucide-react";

/** One entry from `profiles.previewTabs`. */
interface TabInfo {
  targetId: string;
  url: string;
  active: boolean;
}

interface Props {
  profileId: string;
}

/** Poll cadence while the Expand modal is visible. */
const REFRESH_MS = 2000;

/**
 * Accept http(s) URLs and bare hosts (including host:port). Try the raw value
 * first, then prefix `https://`; explicit non-http schemes are rejected.
 */
function parseHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname) {
      return parsed.href;
    }
  } catch {
    /* not a valid absolute URL */
  }
  return null;
}

function normalizeUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^about:blank$/i.test(value)) return "about:blank";
  const direct = parseHttpUrl(value);
  if (direct) return direct;
  // `localhost:3000` looks like a scheme to URL(), but is a host:port.
  const scheme = value.match(/^([a-zA-Z][a-zA-Z\d+.-]*):(.*)$/);
  if (scheme && !/^\d+(?:[/?#]|$)/.test(scheme[2] ?? "")) return null;
  return parseHttpUrl(`https://${value}`);
}

/** Short, human-readable label for a tab's URL. */
function tabLabel(url: string): string {
  if (!url) return "New tab";
  if (/^about:blank$/i.test(url)) return "about:blank";
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname || "New tab";
  } catch {
    return "New tab";
  }
}

/**
 * Compact address bar + tab strip for the Expand modal header. Navigation and
 * tab activation go through the preview bridge; every call is best-effort
 * because the preview may be stopping while the modal is still open.
 */
export function BrowserToolbar({ profileId }: Props): JSX.Element {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [draft, setDraft] = useState("about:blank");
  const mounted = useRef(true);
  const focused = useRef(false);
  const skipBlurRevert = useRef(false);
  const requestId = useRef(0);

  const activeUrl =
    tabs.find((tab) => tab.active)?.url ?? tabs[0]?.url ?? "about:blank";
  const activeUrlRef = useRef(activeUrl);
  activeUrlRef.current = activeUrl;

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.multizen?.profiles;
    if (!api?.previewTabs) return;
    const current = ++requestId.current;
    try {
      const next = await api.previewTabs(profileId);
      if (!mounted.current || current !== requestId.current) return;
      setTabs(Array.isArray(next) ? next : []);
    } catch {
      /* preview may be stopping — keep the last known tabs */
    }
  }, [profileId]);

  // Mount + visibility-aware polling: no timer runs while the document is hidden.
  useEffect(() => {
    mounted.current = true;
    let timer: number | undefined;

    const stop = (): void => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const start = (): void => {
      if (timer !== undefined) return;
      timer = window.setInterval(() => void refresh(), REFRESH_MS);
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        void refresh();
        start();
      } else {
        stop();
      }
    };

    void refresh();
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mounted.current = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  // Mirror the active URL into the input whenever it changes outside editing.
  useEffect(() => {
    if (!focused.current) setDraft(activeUrl);
  }, [activeUrl]);

  const onAddressKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      setDraft(activeUrlRef.current);
      event.currentTarget.blur();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const target = normalizeUrl(draft);
    if (!target) {
      setDraft(activeUrlRef.current);
      return;
    }
    skipBlurRevert.current = true;
    void (async () => {
      try {
        const result = await window.multizen.profiles.previewNavigate(profileId, target);
        if (!mounted.current) return;
        setDraft(typeof result?.url === "string" ? result.url : target);
        await refresh();
      } catch {
        if (mounted.current) setDraft(activeUrlRef.current);
      }
    })();
  };

  const activateTab = (targetId: string): void => {
    void (async () => {
      try {
        await window.multizen.profiles.previewActivateTab(profileId, targetId);
        await refresh();
      } catch {
        /* preview may be stopping — silently ignore */
      }
    })();
  };

  const newTab = (): void => {
    void (async () => {
      try {
        await window.multizen.profiles.previewNewTab(profileId);
        await refresh();
      } catch {
        /* preview may be stopping — silently ignore */
      }
    })();
  };

  const closeTab = (): void => {
    const targetId = tabs.find((tab) => tab.active)?.targetId;
    if (!targetId || tabs.length <= 1) return;
    void (async () => {
      try {
        await window.multizen.profiles.previewCloseTab(profileId, targetId);
        await refresh();
      } catch {
        /* preview may be stopping — silently ignore */
      }
    })();
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <div className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md border border-white/[0.08] bg-black/25 px-2">
        <Globe2 size={13} className="shrink-0 text-slate-500" aria-hidden />
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => {
            focused.current = true;
            skipBlurRevert.current = false;
          }}
          onBlur={() => {
            focused.current = false;
            if (!skipBlurRevert.current) setDraft(activeUrlRef.current);
            skipBlurRevert.current = false;
          }}
          onKeyDown={onAddressKeyDown}
          aria-label="Browser address"
          placeholder="Enter a URL"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-slate-200 outline-none placeholder:text-slate-600"
        />
        <button
          type="button"
          aria-label="New tab"
          title="New tab"
          onClick={newTab}
          className="shrink-0 rounded p-0.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
        >
          <Plus size={13} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Close current tab"
          title="Close current tab"
          onClick={closeTab}
          disabled={tabs.length <= 1}
          className="shrink-0 rounded p-0.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <X size={13} aria-hidden />
        </button>
      </div>
      <div
        role="tablist"
        aria-label="Open tabs"
        className="flex w-full min-w-0 items-center gap-1 overflow-x-auto pb-0.5"
      >
        {tabs.length === 0 && (
          <span className="text-[11px] text-slate-600">No tabs</span>
        )}
        {tabs.map((tab) => {
          const label = tabLabel(tab.url);
          return (
            <button
              key={tab.targetId}
              type="button"
              role="tab"
              aria-selected={tab.active}
              aria-label={`${label} — ${tab.url}`}
              title={tab.url}
              onClick={() => activateTab(tab.targetId)}
              className={`shrink-0 max-w-[180px] truncate rounded px-2 py-0.5 text-[11px] transition-colors ${
                tab.active
                  ? "bg-violet-500/20 text-violet-100 ring-1 ring-inset ring-violet-400/50"
                  : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
