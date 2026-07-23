# Upstream merge status — v0.3.0

**Status:** COMPLETED  
**Merge commit:** `1739d0c` (`Merge upstream v0.3.0 into fork`)  
**Date:** 2026-07-24  
**Remote:** `upstream` → `https://github.com/multizenteam/multizen-browser.git`  
**Branch merged:** `upstream/master` into local `master`  
**Upstream tip:** `0871ad3` (`fix(topbar): make the brand label non-selectable`)  
**Upstream release tag:** `v0.3.0` (`c0759dd chore: release v0.3.0`; tip is +1 commit after the release)  
**Fork tip before merge:** `cb2b457` (`release: v0.7.0`)  
**Divergence at start:** fork **13** commits ahead / **39** commits behind upstream (merge-base `a472f74`, prior sync point around upstream `v0.2.12`)

## Decisions (user)

| # | Topic | Choice | Outcome |
| --- | --- | --- | --- |
| 1 | MCP raw CDP exposure | **A** | Keep fork always-on `cdp_send`, `cdp_send_no_safety`, `probe_fingerprint` + timezone flags. Did **not** adopt upstream `MULTIZEN_MCP_ALLOW_RAW_CDP` gating or remove the unsafe tool. Conflicted regions in `server.ts` / `CdpSession.ts` resolved with `--ours`. |
| 2 | Proxy timezone policy | **A** | Keep fork strict-pin via `resolveLaunchTimezone` + opt-in `alignTimezoneToProxy` / `strictGeoCoherence`. Remaining `ChromiumBrowserDriver.ts` conflict resolved for fork policy/comments. |

## Upstream commits pulled (summary)

From `a472f74` → `0871ad3`, including:

- **v0.2.13 / v0.3.0 releases**
- MCP bearer auth token + Settings UI + README connection docs
- MCP profile CRUD, CDP convenience tools (upstream also gated raw `cdp_send`; fork kept always-on model — see decisions)
- Fingerprint seed / entropy pool expansion (smaller catalog than this fork; fork catalog kept)
- `deviceMemory` API clamp (max 8), timezone-without-proxy fix (#13)
- Extension manifest icons, `.mzar` shared-extension bundling
- CI: pre-create GitHub Release to fix 3-way create race; Intel Mac native-module arch fix
- Profile List view parity / menu click containment (#16)
- Safe Storage profile-local key (not OS keychain)
- Brand label non-selectable topbar fix

## Mechanical conflicts resolved

| File | Resolution |
| --- | --- |
| `package.json`, `apps/desktop/package.json` | Keep fork version **0.7.0** |
| `.github/workflows/release.yml` | **Both**: fork `validate` typecheck gate + upstream `prepare-release` race fix (`build` needs `prepare-release` which needs `validate`) |
| `packages/types/src/index.ts` | Keep fork device-family **superset** |
| `packages/profile-manager/src/fingerprint.ts` + entropy/fingerprint tests | Keep fork expanded catalogs / thresholds / `hostFilter:false` test |
| `packages/mcp-server/src/ActivityLog.ts` | Upstream proxy shape redaction **+** cookie value redaction |
| `ProfileRow.tsx` | Same fix; upstream Issue #16 comment |
| `ChromiumBrowserDriver.ts` (non-TZ hunks) | Fork readiness teardown + `closeAll` opts; upstream `deviceMemoryApiValue`; combined imports |
| `HttpTransport.ts` + `index.ts` | Keep fork **multi-session** transport; wire upstream **auth token** + timing-safe compare + Host allowlist / DNS-rebinding guards |

## About this fork

`README.md` → **About this fork** now lists **Based on upstream release: `v0.3.0`** (no in-progress note).

## Optional follow-ups

```powershell
yarn test:fingerprint
yarn test:fingerprint-entropy
yarn test:launch-timezone
git stash pop   # restores pre-merge edit to .cursor/skills/publish-release/SKILL.md if desired
# push only when asked
```
