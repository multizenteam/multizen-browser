# MultiZen — task track (context per task)

Consolidated from the product/UX discussion. Each entry has enough context to pick up
cold. Status: 🟢 active · 🔵 queued · 🔎 research running · ⏸ blocked/waiting.
Rule for this track: every non-trivial solution (mine included) is validated by an
independent agent with a feedback loop before it's called done.

---

> **Priority note (2026-07-05, independent growth analysis → `specs/growth-analysis/report.md`):**
> Base is **flat ~100–160 active installs**, ~75% download→active drop-off, pre-PMF. Verdict
> re-sequences the track: **#7 (issue-11 DNS) is now highest-leverage** — it breaks the core
> proxy path on the ~60% Windows base and likely feeds the churn. Monetization (#4) is
> **deprioritized** to one static `RECOMMENDED-PROXIES.md` (no billing, no in-app catalog),
> then frozen until installs rise or Pro (patched Chromium) ships. Real growth lever = the
> **LLM/MCP acquisition channel** (chatgpt.com/claude.ai already refer) + waking the existing base.

## 1. Profile card redesign · ✅ done (validated, not yet committed)
**Slug:** `profile-cards`
**Status (2026-07-05):** data + util + UI done (icon column + migration; `profileEmoji`
classifier; `proxyHealth` cached/concurrency-limited hook; emoji avatar + foregrounded proxy-
health row in `ProfileTile`; `EmojiField` picker wired into create/edit). Typecheck + electron-
vite build green. Independent review + fix loop passed: reviewer found 1 MEDIUM race (stuck
"Checking…" when the proxy changes mid-probe → fixed with a `wanted` self-heal map) + 2 LOW
(password missing from cache key; recheck cc flicker) — all fixed and re-verified sound.
**Remaining:** runtime smoke (launch app, eyeball cards) not yet done — build-verified only.
Commit pending (branch first per repo rule).
**Why:** current card shows initials avatar ("JA"/"UP") + tiny id; user wants the card to
foreground **name** and **proxy flag with a live health check** (auto-check + error state),
and replace the initials avatar with either the **country flag** or a **procedural
gradient** generated deterministically from the profile id ("клево и по стилю").
**What we have:** `ProfileTile.tsx` (card), `Avatar.tsx` (initials), `Flag.tsx`
(flag-icons CSS), `proxyCountry` cached on the profile, and IPC
`window.multizen.proxy.detectGeo(proxy, profileId)` → `{ok, geo}|{ok:false,error}` — this
IS the proxy health check (probes ipapi.co through the proxy, persists country).
**Design (LOCKED with user, mockup approved):**
- **Avatar = emoji.** Per-profile `icon?: string` (emoji). If set → use it. Else
  `defaultEmoji(name, tags, id)` — a small keyword classifier (~15 categories: crypto→🪙,
  ads→📢, trading→📈, dev→🛠️, social→💬, ai→🤖, shop→🛒, game→🎮 …) with a hash-stable
  fallback from a ~20-emoji base set. Emoji sits on a muted deterministic tile tint
  (`hash(id)→HSL`). Click avatar → emoji picker (create/edit).
- **Keep the OS icon** in the meta row (Apple/Windows/Linux — already in the app via
  `PlatformIcon`; must survive the redesign).
- **Foregrounded proxy row:** flag + country + live health status (checking / ok / error+
  message / direct). Reuses `detectGeo`; cache per-profile (module Map + TTL), auto-check on
  mount if stale, click row to re-check.
**Persistence:** add `icon TEXT` column to `profiles.db` (idempotent migration like
`proxy_country`/`extensions`); plumb through `create`/`update`/`rowToProfile`; add `icon` to
**`ProfileSummary`** so the card list renders it without loading the full profile.
**Plan:** implement in `ProfileTile.tsx` + `Avatar`→emoji + classifier util + emoji field in
create/edit + ProfileManager column → independent-agent validation.

## 2. Extensions at profile creation ("attach existing" / no "save first") · 🔵 queued
**Slug:** `extensions-at-create`
**Why:** on the create screen we show "Save the profile first — then you can add
extensions". That's a legacy limit from when extensions were per-profile (needed a saved
`dataDir` to unpack into). User wants to add extensions during creation and pull already-
available ones from other profiles — **without their data** (just the read-only files).
**Now feasible thanks to dedup:** the shared store `data/extension-store/` is app-global (no
profile needed to unpack), and `ProfileManager.create(input)` already accepts
`input.extensions`. So:
- **Attach existing:** picker of extensions already in the shared store → add a ref to the
  new profile. Instant, no download, no data (state stays per-profile → new profile is
  logged-out/fresh). This is exactly "pull from neighbouring profiles without data".
- **Install new at create:** unpack to the shared store, hold the ref in form state, pass via
  `create({extensions})`.
**Work:** make `ExtensionsSection` work without a `profileId` (staging mode: collect refs in
form state) + an "existing in store" picker + thread `extensions` into create.

## 3. Per-profile start page + default search · 🟢 3a shipped · ⏸ 3b+newtab deferred to patch
**Slug:** `profile-startpage-search`
**Status (2026-07-05, corrected after real smoke):**
- **3a start page — WORKS, shipped.** First-run positional URL (`sanitizeStartUrl` +
  `hasRestorableSession`), default DuckDuckGo, editable per profile in the "Browser" group.
  User-confirmed in the live app.
- **3b default search — DOES NOT WORK on CloakBrowser → deferred to patched Chromium.**
  Empirically disproven on the real binary: neither pref-seeding
  (`default_search_provider_data`+`enabled`, even a full template with `sync_guid`/`is_active`/
  `input_encodings`) NOR an extension `chrome_settings_overrides.search_provider` activates the
  engine — ungoogled keeps every web engine `is_active=0` and falls back to "No Search". The
  earlier "spike proved it" was wrong (it only checked pref *persistence*, not *activation*).
  Search UI + launch seed were removed; `searchProvider` type/column kept dormant (comment) so
  it can re-land without a migration once patched Chromium ships.
- **New tab / NTP** (obfuscated `chrome.9oo91e.qjz9zk/webstore` on ⌘T): same root cause —
  `chrome_url_overrides.newtab` is also ignored by ungoogled. Deferred to patch. (Start page
  only affects the first launch tab, not new tabs.)

## 3b. Profile card polish (ad-hoc, this session) · ✅ done
- Emoji avatar redesigned to an "inset glass well" (independent agent) — no neon glow, subtle
  hue from the emoji, purple well for AI profiles.
- emoji-mart picker (searchable, local data) replaces the hand-rolled grid.
- Launch button pinned to card bottom (aligns across a row).
- Proxy row shows `proxy` instead of the transport type.
- **Terminating state:** driver emits a `closing` running-changed event (window closed / Stop);
  card shows "Terminating…" until the process exits, instead of a stale "Stop".
**Why:** a fresh profile launches with a single tab = CloakBrowser's obfuscated default
`chrome.9oo91e.qjz9zk/webstore` (ungoogled-style). Looks broken. User wants to set it (e.g.
DuckDuckGo for testing, or the Chrome Web Store since we support extensions), plus the
earlier idea of a **per-profile default search engine**.
**What we have:** launch uses `--restore-last-session` + `session.restore_on_startup=1`; no
explicit startup URL is passed, so the engine's default page shows on first run.
**Design (seed/apply-on-change, NOT enforce — so it doesn't conflict with in-browser
changes):**
- **Start page:** pass a startup URL to Chromium on first launch (no session to restore), or
  seed `session.startup_urls` in Preferences. Per-profile field `startUrl` (default: Web
  Store or a search page).
- **Default search:** seed `default_search_provider_data.template_url_data` into the
  profile's Preferences **only when the user set/changed it in MultiZen** (apply-on-change);
  otherwise never touch it, so a user's in-browser change persists. Policy would LOCK it
  (conflict) → we seed, we don't enforce. Presets: Google/Bing/DDG/Yandex/Startpage/Brave.
**Caveat:** verify seeding works on CloakBrowser 145/146 (ungoogled may validate/strip) —
research/verify spike before promising.

## 4. Proxy monetization (curated referral section) · ⏸ deprioritized (research done)
> **Growth verdict (2026-07-05):** at ~120 active installs realized affiliate income is
> **$10–60/mo, mostly under payout floors** — a rounding error, and an in-app hosted-JSON
> catalog is real engineering for <$60/mo. **Strip to a static `RECOMMENDED-PROXIES.md`
> (3–5 vetted links, no billing, no in-app UI)** = one afternoon, captures the onboarding
> moment; then freeze. Pro license (patched Chromium) is the correct monetization lever
> instead, once shippable. Full reasoning: `specs/growth-analysis/report.md`.

**Slug:** `proxy-monetization`
**Decisions:** model = **hybrid, start with affiliate/referral** (reselling a possible later
phase); section = **curated list** (~5–10 recommended providers + referral links + basic
compare), NOT a full live-priced catalog.
**Freshness "without hacks":** hosted, versioned JSON catalog the app fetches (Hetzner /
static file on getmultizen.com / GitHub raw), git-committed updates, cached + offline
fallback, show "from $X" ranges rather than quoting live prices.
**Privacy:** the catalog fetch must be a plain static GET, no user data, no per-user
tracking; affiliate-link disclosure done transparently (OSS + anti-detect audience).
**Output:** `specs/proxy-monetization/research.md` (agent running) → then spec.

## 5. Anonymous analytics / ping · 🔎 research running
**Slug:** `analytics-ping`
**Decisions:** **count + aggregates** (active installs, OS, version, coarse country), but
genuinely **non-trackable**, opt-out/disclosed, own server on Hetzner, open-source-visible.
**Design lean:** rotating daily-salted ephemeral id (no persistent UUID) + server-side unique
count (e.g. HyperLogLog); derive country from IP then discard IP; daily heartbeat; off-by-
default or clearly disclosed + one-click disable (anti-detect ethos: no silent call-home).
**Reality check:** at tens–hundreds of users, GitHub release download counts already give a
rough floor; research will say whether the ping is worth it.
**Output:** `specs/analytics-ping/research.md` (agent running) → then spec.

## 6. Extension-dedup follow-ups · 🟢 partly done
**Slug:** `ext-dedup-followups`
From the independent validation of issue #10 feedback:
- **Delete dead code:** `unpackToProfile` + `UnpackInput` in `crxPipeline.ts` (0 call sites).
  ✅ done (commit `c08af87`).
- **One-time startup migration of legacy per-profile copies → ❌ DROPPED (won't ship).**
  Independent research (2026-07-05) established it is unsafe: the pre-0.2.10 pipeline never
  injected a manifest `key`, and Web-Store CRX manifests don't carry one, so **essentially
  every legacy per-profile extension runs KEYLESS** — Chromium derives its runtime id from
  `hash(abs load path)` and partitions all state (chrome.storage, IndexedDB, logins) by that
  id. Moving the dir into the shared store changes the path → changes the runtime id → **wipes
  state** (a keyless wallet like MetaMask/Phantom would appear gone) AND doesn't recover the
  genuine store ID (no CRX header when re-unpacking an already-unpacked folder). Only the rare
  extension shipping an explicit `key` inside `manifest.json` is safely migratable — not worth
  a dedicated migration. Legacy copies already load fine via `resolveLoadDir`; disk cost is
  bounded; **keep the existing lazy-on-reinstall migration** (`ExtensionsService.persist`/
  `reclaim`). If disk reclamation is ever wanted, dedup ONLY the `key`-present subset.
- **Latent note (still true, now explained):** keyless installs store `id = contentHashId`
  while Chromium's runtime id = `hash(abs path)`; `computeExtensionId({absPath})` is exported
  but has **0 call sites**, so nothing ever computes the real runtime id — which is exactly why
  keyless state can't be relocated. Documented; no code change.
- **Reply to ahive on #10:** DRAFTED, pending user approval to post (outward-facing). Explains
  the MV2 gate (why classic uBO was refused), uBO Lite as the MV3 path + its Basic-mode caveats,
  and that MV2-on-145 is under evaluation. See task #8.

## 8. Ad-blocking / Manifest V2 on CloakBrowser 145 · 🟡 decision needed
**Slug:** `mv2-adblock`
Triggered by issue #10 (ahive: "all ad block extensions are paralyzed"). Root cause: MultiZen's
own gate `crxPipeline.ts:82` rejects `manifest_version !== 3`, so classic uBlock Origin (MV2) is
refused on upload (file AND Web-Store). Research (2026-07-05):
- Chromium disabled MV2 for all users in **138**; **145** (our engine, shipped Feb 2026) still
  has the `ExtensionManifestV2*` feature flags; **150** (Jun 30 2026) removes the last override.
- **CloakBrowser is ungoogled-based**, and ungoogled ships `extensions-manifestv2.patch` that
  **unconditionally re-enables MV2** (no flag). So classic uBO likely CAN run on our 145 engine
  if we drop our gate — **UNVERIFIED for this exact CloakBrowser build; needs an empirical test**
  (bypass the gate, hand-place an MV2 ext, launch, confirm it loads AND blocks).
- uBO **Lite** (MV3) works today via `--load-extension` but is weaker: Basic mode by default (no
  custom filter lists, no per-site dynamic filtering), Optimal/Complete need per-site host
  permissions we can't pre-grant via CLI; DNR rule caps (~330k static / 30k dynamic).
**Options:** (a) recommend uBO Lite only, keep the MV2 gate; (b) empirically verify + ship an
**opt-in "Allow Manifest V2 extensions"** toggle (fixes classic uBO on 145, but MV2 is terminal —
dies when we track CloakBrowser past 145). Strategic call for the maintainer.

## 9. In-app curated extension catalog · 🔎 research running
**Slug:** `extension-catalog`
User idea (2026-07-05): show a built-in, official-feeling gallery of popular extensions grouped
by category, with icons + names, searchable, one-click install. Uses the existing
`installFromWebStore(id)` path — no new install plumbing.
**Key constraints (my critical read):**
- No official Web-Store "top-N per category" API. Scraping category pages is fragile + gec/locale-
  dependent → **curate** a quality MV3-only list instead (stable, verifiable IDs), don't auto-scrape.
- **MV3-only** for now (our gate rejects MV2); badge/exclude MV2 favourites (classic uBO) — ties to #8.
- **Icons offline:** a build-time script fetches `og:image`/`og:title`/`og:description` from each
  detail page by ID and bundles PNGs → no runtime network, no fingerprint impact.
- Staleness: bundle JSON for v1; consider hosted JSON later (like #4) to update without a release.
**Research agent (2026-07-05):** verifying metadata-by-ID is retrievable (og: tags) + assembling a
seed catalog (categories × verified MV3 IDs). → then spec/plan/implement/review.
**UI open Q:** own left-rail section ("Discover"/"Extensions") vs a picker inside the create/edit
Extensions section (overlaps #2 "attach existing / install at create").

## 7. Issue #11 — DNS NXDOMAIN (Win10 LTSC) · ⏸ waiting on reporter — ⬆ NOW HIGHEST PRIORITY
**Slug:** `issue-11-dns`
> **Growth verdict (2026-07-05):** this is the single highest-leverage item on the track — it
> breaks the core proxy/remote-DNS path on the ~60% Windows base and almost certainly feeds the
> ~75% download→active churn. If the reporter goes quiet, spin up a Win10 LTSC VM and reproduce
> proactively rather than waiting. Confirm the SOCKS5-bridge code path when fixing.
Reporter hits `DNS_PROBE_FINISHED_NXDOMAIN` with/without proxy on Win10 LTSC + local DNS;
rus sites fail. Verified: our DNS/bridge flags are proxy-only; the SOCKS5 bridge correctly
does remote DNS (ATYP=domain). Likely environment/engine-Windows-specific, not a universal
regression (works on macOS incl. rus sites). Asked reporter for net-internals + repro
details. Optional: spin up a Win10 LTSC VM to reproduce. Possible fixes if confirmed:
clearer bridge error codes (0x04 host-unreachable vs 0x05), an option to use system DNS.
