# Spec — per-profile start page + default search (#3)

**Slug:** `profile-startpage-search` · **Date:** 2026-07-05
**Decisions LOCKED with user + empirically de-risked (see `research.md` §4).**

## What & why
A fresh profile opens the obfuscated `chrome.9oo91e.qjz9zk/webstore` NTP (looks broken). Users
want to (a) set the **start page**, and (b) set a **per-profile default search engine**. Both
are seeded on our terms without enforcing (so in-browser changes still persist).

## Locked decisions
- **Default start page** when a profile has no explicit `startUrl`: **`https://duckduckgo.com/`**.
- **Scope:** ship **both 3a and 3b** (spike proved both work on CloakBrowser 145).
- **Search presets:** Google, Bing, DuckDuckGo, Yandex, Startpage, Brave, + Custom.
- **3a mechanism:** positional URL argv, only on first-run (no restorable session).
- **3b mechanism:** seed `default_search_provider_data.template_url_data` +
  `default_search_provider.enabled=true` into `Default/Preferences`, apply-on-change.

## Behaviour
### Start page (3a)
- New field `startUrl?: string` on the profile. Empty/unset → use the app default
  (`https://duckduckgo.com/`). A user can set any URL (or `about:blank`).
- On launch, if the profile has **no restorable session** (first run, or session data absent),
  append `startUrl` (or the default) as a positional arg so it opens as the initial tab.
- If a session IS restorable, do nothing (— `--restore-last-session` brings tabs back; don't
  stack an extra tab).

### Default search (3b)
- New field `searchProvider?: string` = a preset id (`google|bing|duckduckgo|yandex|startpage|
  brave`) or `custom:<name>|<url-with-{searchTerms}>` (kept simple: store the preset id; custom
  stores name+url).
- On launch, **only if `searchProvider` is set**, seed `default_search_provider_data.template_url_data`
  (from a preset table) + `default_search_provider.enabled=true` into `Default/Preferences`
  (extend `ensureSessionRestore` → `seedProfilePrefs`). If unset → never touch the search prefs,
  so a user's in-browser choice persists.
- Seeding is idempotent (re-seed the same data each launch while the field is set); we never
  read it back or fight the user's live changes beyond the seeded default.

## Data / plumbing (mirror the just-shipped `icon` pattern)
- `@multizen/types`: add `startUrl?: string` + `searchProvider?: string` to `Profile`,
  `CreateProfileInput`, `UpdateProfileInput` (update allows `| null` to clear).
- `ProfileManager`: idempotent `ALTER TABLE profiles ADD COLUMN start_url TEXT` +
  `search_provider TEXT`; plumb through create/update/list?/get/rowToProfile. (list/ProfileSummary
  don't need these — they're launch-time only, not card-rendered.)
- Launch (`ChromiumBrowserDriver.ts`): first-run detection helper +
  positional URL; `seedProfilePrefs` writes search data.
- Preset table (main-side): id → `{short_name, keyword, url, suggestions_url?, prepopulate_id?}`.
- GUI: create/edit sheets — a "Browser" group with **Start page** (text, placeholder = default)
  and **Default search** (dropdown of presets + "Custom…").

## Non-goals / deferred
- Per-profile homepage button, multiple startup URLs, search suggestions tuning.
- Enforcing search (policy lock) — explicitly rejected (conflicts with user changes).

## Tasks (one commit each)
1. types: `startUrl` + `searchProvider` on Profile/Create/Update.
2. ProfileManager: columns + migration + create/update/get/rowToProfile plumbing.
3. Launch 3a: first-run detection + positional start URL (default DDG).
4. Launch 3b: `seedProfilePrefs` search seeding from a preset table (apply-on-change).
5. GUI: "Browser" group (Start page + Default search) in New + Edit sheets.
6. Typecheck + electron-vite build; independent-agent review + fix loop.

## Verification
- Spike already proved the launch mechanics on CloakBrowser 145 (research §4).
- Smoke: create a profile with DDG search + a custom start URL, launch, confirm the tab + the
  omnibox search engine; create one WITHOUT search set, change engine in-browser, relaunch,
  confirm the in-browser choice persisted (apply-on-change didn't clobber it).
