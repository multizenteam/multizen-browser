# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] - 2026-07-24

Synced with upstream `multizenteam/multizen-browser` v0.3.0 while keeping this
fork's MCP/CDP surface (always-on `cdp_send` / `cdp_send_no_safety` /
`probe_fingerprint`) and strict-pin launch timezone policy.

### Added

- **MCP HTTP bearer auth** — local MCP server requires a token; Settings shows
  the token and connection docs use it so Cursor / Claude / Codex can authenticate.
- **Real extension manifest icons** for non-catalog extensions in the profile UI.
- **Shared extensions bundled into `.mzar` exports** so import restores
  attached extensions without a separate download step.

### Changed

- Profile **List view** brought to visual parity with grid cards; menu clicks no
  longer open Edit Profile by accident.
- Launch uses a **profile-local Safe Storage key** instead of the OS keychain.
- Top bar brand label is non-selectable (`pointer-events: none`).
- MCP activity log / `list_profiles` redact proxy credentials (and related
  sensitive fields) more thoroughly.
- HTTP MCP transport gains Host allowlist / DNS-rebinding guards alongside the
  fork's multi-session transport.

### Fixed

- `navigator.deviceMemory` clamped to the API maximum of 8.
- Profile timezone applied correctly when no proxy is set.
- Intel Mac builds ship the correct-arch native module; clearer startup errors
  when the engine fails to load.

### CI

- Release workflow pre-creates the GitHub Release to avoid the 3-way create
  race across the OS matrix (combined with this fork's validate/typecheck gate).

## [0.7.0] - 2026-07-17

### Added

- **Strict-pin launch timezone policy** (`resolveLaunchTimezone`): pinned
  `fingerprint.timezone` wins by default; proxy geo still feeds WebRTC IP +
  geolocation. Opt-in profile flags `alignTimezoneToProxy` /
  `strictGeoCoherence` (MCP create/update + SQLite).
- **`check-chrome-version`** script + bump notes in
  [`docs/fingerprint-entropy-verification.md`](docs/fingerprint-entropy-verification.md)
  to keep `CHROME_VERSION_*` aligned with CloakBrowser/CFT (skips cleanly when
  no binary is present). Generate-time constants set to **146.0.7680.177** to
  match the current CloakBrowser cache major (launch still reconciles UA/CH).
- Expanded **Mac (M2/M3/M4 Pro/Air/mini/iMac)** and **Linux laptop + desktop**
  device catalogs; entropy thresholds Mac/Linux ≥15 coarse / ≥8 WebGL;
  `generateFingerprint(seed, { hostFilter: false })` for CloakBrowser-style
  full-catalog tests.
- MCP **`probe_fingerprint`**: live UA/platform/languages/hwc/memory/screen/
  WebGL/timezone (+ canvas hash) vs stored fingerprint → `{ ok, live, expected, drift }`.
- **`smoke-fingerprint-seed`** script (offline always; live canvas path when
  MultiZen MCP is reachable).

### Changed

- CI runs fingerprint unit/entropy/version-check scripts, desktop timezone
  tests, and offline smoke after typecheck.
- Archived 0.6.0 brief [`docs/multizen-fork-fingerprint-tasks.md`](docs/multizen-fork-fingerprint-tasks.md);
  verification notes point at the post-0.6 backlog.

### Out of scope (not in 0.7.0)

- F UA/CH build jitter
- G fonts / speech / mediaDevices / extra client hints

## [0.6.0] - 2026-07-17

### Added

- **Higher fingerprint entropy and OS/device coherence** so profiles drawn from
  the pool look more like real hardware combinations and are harder to correlate
  across accounts.
- Optional **fingerprint seed** for canvas/audio (and related) noise - rotate
  spoofed noise without changing the profile id or recreating the profile.
- Fingerprint entropy verification helpers under `profile-manager` for
  checking pool uniqueness and coherence.

### Changed

- Mac device families are recognized more broadly (`mac*` / `imac`) for
  platform icons and CloakBrowser native platform args.
- MCP profile create/update surfaces accept the expanded fingerprint fields
  (including seed) so automation stays in sync with the desktop app.

## [0.5.0] - 2026-07-07

Synced with upstream `multizenteam/multizen-browser` v0.2.12, bringing its
feature set into the extended fork while keeping the fork's MCP/CDP tooling.

### Added

- **Per-profile start page.** Each profile can set its own start URL, opened on
  first launch (sanitized, with a safe default) instead of a fixed page.
- **In-app extensions catalog.** Browse a curated set of MV3 extensions — shown
  with their real Chrome Web Store icons — and add or attach them while creating
  a profile.
- **Emoji profile avatars.** Choose an emoji (with automatic color tinting) as a
  profile avatar through the new emoji picker.
- **In-app MCP panel** with a Copy-for-LLM connect card, so pointing
  Cursor / Claude / Codex at the local server is a one-click copy.
- **Opt-in anonymous telemetry** — a default-off onboarding consent step plus a
  self-hostable ingest service. Nothing is ever sent from dev/unpackaged builds.

### Changed

- **Redesigned profile create/edit flow and cards** — Discord-style sidebar
  navigation in the New and Edit profile sheets (with edit autosave), roomier
  modals, refreshed profile tiles, and a clear terminating state while a profile
  winds down.
- Per-profile proxy health is now surfaced in the UI.

### Fixed

- Profile import now restores faithfully (id, data directory, and every field)
  and rejects unsafe archive ids and path-traversal attempts.

## [0.4.1] - 2026-07-01

### Added

- Four new fingerprint locales — Pakistan (`en-PK`), Bangladesh (`bn-BD`),
  Cambodia (`km-KH`) and Bolivia (`es-BO`) — each with its matching languages
  and timezone, widening the pool of regions a profile can convincingly
  emulate.

## [0.4.0] - 2026-06-29

### Added

- **Direct CDP (Chrome DevTools Protocol) access over MCP.** New `cdp_send`
  tool runs any CDP command safely — it auto-disables only the domains it had
  to enable, never disturbs the page session, and refuses automation-revealing
  enables on anti-detect (CloakBrowser) engines — plus `cdp_send_no_safety`
  for an unrestricted raw passthrough when you knowingly need it.
- **CDP convenience tools** built on top of `cdp_send`: `evaluate_js`,
  `wait_for_selector`, `get_cookies` / `set_cookies`, tab control
  (`list_tabs`, `new_tab`, `activate_tab`, `close_tab`), and
  `wait_for_navigation` / `wait_for_load`.

### Changed

- `launch_profile` now waits until the browser is actually drivable (CDP
  endpoint → page target → attach) before returning, so an immediate
  `navigate` / `extract` right after launch no longer fails with
  "not connected" or "no execution context". Cloaking is armed before the
  wait so restored tabs are never exposed.

### Fixed

- Closing a profile now reliably terminates the **entire** Chromium process
  tree (renderers, GPU, utility children) instead of just the root process, so
  orphaned processes can no longer linger and lock a profile's data directory
  on the next launch. The force tree-kill is a fallback after the graceful
  shutdown, so session-restore is preserved (Windows `taskkill /T`, Unix
  process-group kill).

## [0.3.1] - 2026-06-29

### Fixed

- Launching a profile on Windows no longer flashes an extra Chromium window:
  version detection now reads the cached bootstrap version or the EXE file
  metadata instead of spawning `chrome.exe --version` (which opens a normal
  browser window on Windows).
- Profile row and tile action-menu clicks no longer bubble to the row and
  open the edit modal on top of the chosen action (e.g. the delete-confirm
  dialog).
- The in-app updater now links to releases on this repository instead of the
  upstream `multizenteam` repo.

### Changed

- Settings About now displays "MultiZen Extended".

## [0.3.0] - 2026-06-29

### Added

- MCP HTTP server now supports the modern Streamable HTTP transport (`POST/GET/DELETE /mcp`) in addition to the legacy HTTP+SSE endpoints, so up-to-date Cursor/Claude clients connect over the current protocol.
- `/healthz` now reports active MCP session counts per transport for easier diagnostics.

### Fixed

- MCP no longer becomes unresponsive after a client reconnects: each connection now gets its own session and dedicated server binding, so a dropped or zombie SSE connection can no longer wedge the active session (previously this required killing the app via Task Manager).
- Closing MultiZen with the window close button now reliably quits the app even while an MCP client is connected — the shutdown path no longer hangs on an open keep-alive SSE socket. Added forced socket teardown in the HTTP transport and a quit watchdog in the main process.
- Closing a profile no longer risks a shutdown deadlock between the SOCKS5 proxy bridge and a still-running Chromium: Chromium is shut down before the bridge, and bridge sockets are force-closed.

### Changed

- Multiple MCP clients can now connect concurrently without breaking each other's sessions.

## [0.2.11] - 2026-06-29

### Added

- **Full profile CRUD over MCP.** New `update_profile` and `delete_profile`
  tools, plus a `list_fingerprint_options` discovery tool that enumerates the
  valid device families (with real screen sizes) and locale groups (locale,
  country, plausible timezones).
- `create_profile` now accepts an optional `proxy` and high-level `fingerprint`
  configuration at creation time, so a profile can be fully provisioned in a
  single call.
- High-level fingerprint knobs for `create_profile` / `update_profile`
  (`device`, `localeId`, `timezone`, `screen`, `hardwareConcurrency`,
  `deviceMemory`). Raw fingerprint surfaces (User-Agent, Client Hints, WebGL)
  cannot be set individually — the server derives a coherent configuration via
  `reconcileFingerprint` so detection vendors can't flag a mismatch.

### Changed

- `delete_profile` closes a running browser before removing the profile's data
  directory, so a live Chromium handle can't block deletion on Windows.
- `update_profile` reports `appliesOnNextLaunch` when the target profile is
  running, since proxy/fingerprint changes only take effect on relaunch.

### Security

- Proxy `username` / `password` are now redacted from the activity log so
  credentials never reach the audit stream.

### CI

- Added a `CI` workflow (typecheck on every pull request and push to `master`).
- The release workflow now runs a typecheck gate before building.
- Retargeted the electron-builder publish provider to this repository.

## [0.2.10] - 2026-06-28

### Added

- Shared, deduplicated extension store with genuine store-ID injection — one
  copy per extension version is shared across profiles.

### Fixed

- "Add to MultiZen" companion button now places correctly on the current
  Chrome Web Store layout.
- CI: disabled `setup-node` package-manager cache, which conflicted with the
  Yarn 4 / Corepack activation order.

## [0.2.9] - 2026-06-18

### Added

- **Per-profile browser extensions (Phase 1).** CRX / ZIP / folder unpack
  pipeline (MV3-only, atomic), download `.crx` by ID from the Web Store, a
  bundled "Add to MultiZen" companion extension, an Extensions section in the
  profile sheets, and a CDP binding that routes the companion button back to
  the host with auto-relaunch.
- Auto-fill proxy fields from a pasted one-line proxy string.

### Fixed

- Proxy parser disambiguates `host:port@user:pass` when the password is
  numeric.

## [0.2.8] - 2026-06-17

### Added

- **App self-update (Phase 1).** `electron-updater`-based updater with a
  platform-gated service, an Updates section in Settings (current version,
  manual check, auto-update toggle), and a dismissible update banner.
  Auto-install on Windows/Linux; notify-only on macOS (no Apple Developer ID).
- `autoUpdate` setting (default on) and an `UpdateStatus` discriminated union.

### Changed

- Release workflow and CI moved to Node 24 with `actions/*@v5`.

## [0.2.2] - 2026-05-14

### Added

- Modern README with screenshots, badges, and install paths.

### Fixed

- macOS builds are now ad-hoc signed to avoid the "is damaged" Gatekeeper
  dialog.
- Resumable, self-verifying patched-Chromium download with retries and
  truncation detection, fetched via the Electron `net` stack.
- Cross-platform packaging: bundle native dependencies, `asarUnpack` for
  `better-sqlite3`, and strip `@multizen/*` workspace symlinks between
  electron-vite and electron-builder.

## [0.2.0] - 2026-05-13

### Added

- **v2 pivot: AI-native MCP browser.** Full repository rewrite around a
  Model Context Protocol server that drives anti-detect Chromium profiles.
- MCP server with the core browser-drive tool surface (`list_profiles`,
  `create_profile`, `launch_profile`, `close_profile`, `navigate`, `click`,
  `type`, `extract`, `screenshot`), stdio + HTTP/SSE transports, and a mock
  driver for protocol testing.
- Real CDP driver (`chrome-remote-interface`), profile manager with SQLite
  storage and a coherent fingerprint pool, encrypted profile export/import,
  per-profile SOCKS5 bridge with persona alignment, and the activity log.
- GitHub Actions release workflow with stable, version-less download URLs.

[0.7.1]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.11...v0.3.0
[0.2.11]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.2...v0.2.8
[0.2.2]: https://github.com/kiserufetch/multizen-browser-extended/compare/v0.2.0...v0.2.2
[0.2.0]: https://github.com/kiserufetch/multizen-browser-extended/releases/tag/v0.2.0
