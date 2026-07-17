# Fingerprint entropy verification notes (§6)

Unit/scripts cover P0-1…P0-6 + P1-7 logic plus post-0.6 (0.7) helpers. After
deploying a MultiZen binary with MCP, run this checklist against the live
server (e.g. `:7777`).

Post-0.6 backlog: [`docs/multizen-post-0.6-task.md`](./multizen-post-0.6-task.md).
Shipped P0/P1 brief (0.6.0): [`docs/multizen-fork-fingerprint-tasks.md`](./multizen-fork-fingerprint-tasks.md) (archived / Done).

## Scripts (source / CI)

From repo root:

```bash
npx tsx packages/profile-manager/scripts/test-fingerprint.ts
npx tsx packages/profile-manager/scripts/test-fingerprint-entropy.ts
npx tsx packages/profile-manager/scripts/check-chrome-version.ts
npx tsx packages/mcp-server/scripts/smoke-fingerprint-seed.ts
# or: yarn smoke:fingerprint-seed
yarn workspace @multizen/desktop test   # includes resolveLaunchTimezone
```

Expected: fingerprint + entropy + desktop unit tests exit 0.

- **Windows host:** entropy ≥20 coarse / 30 seeds and ≥10 WebGL / 50 seeds.
- **Mac/Linux host:** entropy ≥15 coarse / 30 seeds and ≥8 WebGL / 50 seeds.
- `check-chrome-version.ts` exits 0 with a skip message when no CloakBrowser/CFT
  binary is present (typical CI ubuntu). Aligns `CHROME_VERSION_*` to the
  installed binary major when present (see [`docs/chrome-version-bump.md`](./chrome-version-bump.md)).
- Smoke script always runs **offline** seed/coarse-hash checks. Live canvas
  path needs MultiZen MCP (`MULTIZEN_MCP_URL`, default `http://127.0.0.1:7777`).
  Without a live app it prints `live SKIPPED` and exits 0. Set
  `MULTIZEN_SMOKE_LIVE=1` to fail if MCP is unreachable.

Also useful against a running session: MCP tool `probe_fingerprint`
(`{ profile_id }`) → `{ ok, live, expected, drift[] }` (requires a build that
includes the 0.7 tool).

## MCP checklist (deployed binary)

### 6.1 Catalog

- [ ] Call `list_fingerprint_options`.
- [ ] Confirm `locales` includes `en-PK`, `bn-BD`, `km-KH`, `es-BO` with expected IANA timezones (`Asia/Karachi`, `Asia/Dhaka`, `Asia/Phnom_Penh`, `America/La_Paz`).
- [ ] Confirm expanded `devices` (Windows Intel/AMD/NVIDIA laptop+desktop, Linux laptop+desktop AMD/NVIDIA/Intel, Mac M2/M3/M4 Air/Pro/mini/iMac).

### 6.2 Create honors spec

```json
{
  "name": "pk-spec",
  "fingerprint": {
    "localeId": "en-PK",
    "timezone": "Asia/Karachi",
    "screen": { "width": 1920, "height": 1080 },
    "hardwareConcurrency": 8,
    "deviceMemory": 8
  }
}
```

- [ ] Read back profile fingerprint: fields must match exactly. Unknown `localeId` (e.g. `xx-YY`) must return `INVALID_INPUT` and not create a profile.

### 6.3 Parallel diversity + seed

- [x] Offline: ≥5 seeds same `localeId` → distinct coarse hashes (`smoke-fingerprint-seed.ts`, 2026-07-17).
- [x] Live canvas: different seeds → different canvas hashes; same seed relaunch → same hash; `update_profile` seed → hash changes (smoke against local MCP `:7777` + CloakBrowser, 2026-07-17).
- [ ] Manual: ≥5 parallel `create_profile` via MCP UI/client coarse-hash spot-check on a packaged ≥0.7.0 build.

### 6.4 Negatives + probe

- [x] No silent `en-PK` / `bn-BD` → `fr-FR` (unit entropy script, 2026-07-17).
- [x] Desktop screen never yields mobile UA (unit-covered).
- [x] Old clients without `seed` still work with `{ localeId, timezone }` only (unit).
- [ ] `probe_fingerprint` on CloakBrowser: pinned fields `drift=[]` (needs MultiZen build that ships the 0.7 tool — running 0.6 MCP may not expose it).

### Live gate status

| Gate | Status | Notes |
|------|--------|--------|
| Offline unit/entropy/TZ/version/smoke | Pass | 2026-07-17 (Windows host) |
| Live canvas seed smoke via MCP | Pass | 2026-07-17, CloakBrowser `146.0.7680.177`, MCP `:7777` |
| Full §6.1–6.4 packaged-binary checklist | Partial | Catalog / probe / packed-build UI checks still open until a 0.7.0 install is re-verified end-to-end |

## Chrome version bump (generate-time constants)

MultiZen stores Chrome UA / Client Hints defaults in
`packages/profile-manager/src/fingerprint.ts`:

- `CHROME_VERSION_MAJOR`
- `CHROME_VERSION_FULL`

On every profile launch, `ChromiumBrowserDriver` runs
`reconcileVersionInFingerprint` so the **live** UA and Sec-CH-UA brand versions
match the actual CloakBrowser / Chrome-for-Testing binary major — even if the
generate-time constants lag. Stale constants still hurt freshly generated
profiles and CI drift checks.

**When to bump:** update `CHROME_VERSION_*` when you ship a new CloakBrowser or
CFT cache whose **major** differs from the constants.

1. Confirm binary version (Settings → engine status, `current.json` under the
   chromium cache, or `MULTIZEN_CHROMIUM_BIN`).
2. Set `CHROME_VERSION_MAJOR` / `CHROME_VERSION_FULL` to match.
3. Run `npx tsx packages/profile-manager/scripts/check-chrome-version.ts` and
   `npx tsx packages/profile-manager/scripts/test-fingerprint.ts`.
4. Note the bump in `CHANGELOG.md`.

`check-chrome-version.ts` fails if `|constMajor - binaryMajor| > THRESHOLD`
(default **0**). Exits 0 with a skip message when no binary is present.
Optional: `MULTIZEN_CHROME_MAJOR_THRESHOLD=1` during a rolling upgrade.

## Out of scope here

- F UA/CH build jitter
- G fonts / speech / mediaDevices / extra CH
- Live proxy pools / JA3 / site-specific fixes
