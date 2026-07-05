# Research — per-profile start page + default search (#3)

**Date:** 2026-07-05 · Slug `profile-startpage-search`
**Goal:** (a) stop fresh profiles from opening the weird obfuscated
`chrome.9oo91e.qjz9zk/webstore` tab — let the user pick a start page; (b) allow a
per-profile **default search engine**.

## 1. Why the weird tab happens (root cause, verified in code)

Launch (`ChromiumBrowserDriver.ts:201-245`) unconditionally passes:
- CLI `--restore-last-session` (`:237`)
- and flips `session.restore_on_startup = 1` in `Default/Preferences` via
  `ensureSessionRestore()` (`:206`, impl `:1682-1717`).

That reliably restores tabs across stop→launch. **But on a brand-new profile there is
no session to restore**, so Chromium falls back to the New Tab Page. In our ungoogled-based
CloakBrowser the NTP/webstore surface is the domain-obfuscated
`chrome.9oo91e.qjz9zk/webstore` — which reads as broken. We never set a homepage, startup
URL, or search provider anywhere (grep: zero hits across `apps/desktop/src` + `packages/`),
so the browser default wins.

## 2. The seeding mechanism we already own

`ensureSessionRestore()` is the pattern to extend: it reads `Default/Preferences` (JSON),
mutates keys, atomically re-writes (tmp + rename) **before spawn** (Chromium must be off).
This is exactly where Chrome-family preferences are seeded. Two Chromium prefs matter:

- **Startup:** `session.restore_on_startup` (1 = restore last, 4 = open specific URLs, 5 =
  NTP) + `session.startup_urls: string[]`.
- **Default search:** `default_search_provider_data.template_url_data` (an object with
  `keyword`, `short_name`, `url` (the `{searchTerms}` template), `suggestions_url`,
  `favicon_url`, `prepopulate_id`, etc.). Also `default_search_provider.enabled = true`.

## 3. Design (seed-not-enforce — must not fight in-browser changes)

The user changes things *inside* the browser too. Policy-style enforcement (`ExtensionSettings`
/ managed prefs) would LOCK the value and conflict. So: **seed on our terms, never enforce.**

### 3a. Start page — first-launch only
Add per-profile `startUrl?: string`. On launch, detect "first run" = no restorable session
(no `Default/Sessions/` dir / `Current Session` file, or `lastOpenedAt` is unset). Only then
open the start page; otherwise `--restore-last-session` brings the real tabs back.

Two viable ways to open it on first run:
1. **Positional URL arg** — append `startUrl` as a positional arg to the Chromium argv. Opens
   as the initial tab. Simplest; no pref surgery. Risk: if combined with restore it stacks an
   extra tab — hence gate strictly on first-run.
2. **Seed `session.startup_urls=[startUrl]` + `restore_on_startup=4`** for the first launch,
   then let `ensureSessionRestore` set it back to `1` on subsequent launches.

**Lean: option 1 (positional arg), gated on first-run.** Least stateful, least likely to be
stripped/validated by ungoogled, and doesn't perturb the restore machinery that already works.

Default `startUrl` when the user hasn't set one: candidates — `https://duckduckgo.com`
(privacy, matches anti-detect ethos), the Chrome Web Store (`https://chromewebstore.google.com`,
since we support extensions), or `about:blank`. **Needs a product decision (see §6).**

### 3b. Default search — apply-on-change only
Add per-profile `searchProvider?` (preset id or a custom `{name, keyword, url}`). Seed
`default_search_provider_data.template_url_data` into Preferences **only when the user sets or
changes it in MultiZen** (apply-on-change). If unset → never touch the key, so a user's
in-browser search change persists. Presets: Google / Bing / DuckDuckGo / Yandex / Startpage /
Brave (+ custom).

## 4. Verify spike — DONE (empirical, CloakBrowser 145.0.7632.109.2, 2026-07-05)

Ran against the real cached CloakBrowser binary (temp user-data-dir, seeded Preferences,
launched with remote-debugging, inspected open targets via CDP + read prefs/Web Data back).

**Result 3b (default search): SEEDING WORKS.** Seeded `default_search_provider_data.template_url_data`
(DDG, prepopulate_id 92) + `default_search_provider.enabled=true` → **survived launch intact**
(CloakBrowser only re-sorted the JSON keys, kept every field), and DuckDuckGo appears in the
authoritative `Default/Web Data` `keywords` table with the exact seeded URL. → **3b is feasible
via pref-seed on CloakBrowser 145; no source patch needed.**

**Result 3a (start page): pref `startup_urls` DID NOT WORK, positional arg DOES.**
- Seeding `session.restore_on_startup=4` + `session.startup_urls=["https://duckduckgo.com/"]`
  → the prefs persisted but the browser opened **`chrome://newtab/`**, ignoring the pref. So
  pref-based startup is unreliable on CloakBrowser (matches the ungoogled NTP patching theory).
- Passing the URL as a **positional argv** (`… "https://duckduckgo.com/"`) → opened
  **`https://duckduckgo.com/`**. ✓
- Combined test mirroring production (`--restore-last-session` + `restore_on_startup=1` pref +
  positional URL, fresh profile) → still opened DDG. **No conflict on first-run** (nothing to
  restore → the command-line URL wins). ✓

**Locked approach:** 3a = positional URL arg, gated to first-run (no restorable session). 3b =
pref-seed `default_search_provider_data` + `enabled`, apply-on-change.

## 5. Persistence & plumbing (same pattern as the just-shipped `icon`)
- Add `startUrl?: string` (and `searchProvider?`) to `Profile` / `CreateProfileInput` /
  `UpdateProfileInput` in `@multizen/types`; idempotent `ALTER TABLE` columns in
  `ProfileManager` (like `icon`/`proxy_country`); plumb through create/update/rowToProfile.
- GUI: a "Start page" field + "Default search" dropdown in create/edit (General or a new
  "Browser" group).
- Launch: extend `ensureSessionRestore` (or a sibling `seedProfilePrefs`) to write search data;
  add first-run start-URL logic to the args builder.

## 6. Decisions needed from the user
1. **Default start page** for profiles with no `startUrl` set: DuckDuckGo / Chrome Web Store /
   blank / something else?
2. **Scope now:** ship **3a (start page) first** and gate **3b (default search) behind the
   CloakBrowser verify spike** — agree? (3a solves the visible complaint; 3b may need Pro.)
3. **Search presets** list: Google/Bing/DDG/Yandex/Startpage/Brave + custom — good set?

## 7. Risks
- ungoogled stripping seeded prefs (→ spike gates 3b).
- Positional start-URL stacking an extra tab if first-run detection is wrong (→ gate on a
  reliable signal: absence of `Default/Sessions/` **and** `lastOpenedAt == null`).
- Seeding a malformed `template_url_data` can wedge search (→ validate against a known-good
  Chromium prepopulated entry; keep `prepopulate_id` where possible).
