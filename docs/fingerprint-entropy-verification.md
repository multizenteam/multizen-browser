# Fingerprint entropy verification notes (§6)

Unit/scripts cover P0-1…P0-6 + P1-7 logic. After deploying a MultiZen binary with MCP, run this checklist against the live server (e.g. `:7777`).

## Scripts (source / CI)

From repo root:

```bash
npx tsx packages/profile-manager/scripts/test-fingerprint.ts
npx tsx packages/profile-manager/scripts/test-fingerprint-entropy.ts
```

Expected: both exit 0. On Windows hosts, entropy script requires ≥20 coarse combos / 30 seeds and ≥10 WebGL pairs / 50 seeds for `bn-BD` and `en-PK`.

## MCP checklist (deployed binary)

### 6.1 Catalog

1. Call `list_fingerprint_options`.
2. Confirm `locales` includes `en-PK`, `bn-BD`, `km-KH`, `es-BO` with expected IANA timezones (`Asia/Karachi`, `Asia/Dhaka`, `Asia/Phnom_Penh`, `America/La_Paz`).
3. Confirm expanded `devices` families (Windows Intel/AMD/NVIDIA laptop+desktop, Linux AMD/NVIDIA, Mac Air 15 / mini).

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

Read back profile fingerprint: fields must match exactly. Unknown `localeId` (e.g. `xx-YY`) must return `INVALID_INPUT` and not create a profile.

### 6.3 Parallel diversity + seed

Create ≥5 profiles with the same `localeId` (`bn-BD` or `en-PK`), different top-level `seed` values. Coarse hashes of `userAgent|platform|webgl|screen` should mostly be unique. Different seeds → different CloakBrowser `--fingerprint=` numeric seeds (canvas/audio noise); same seed recreate → stable noise.

### 6.4 Negatives

- No silent `en-PK` / `bn-BD` → `fr-FR`.
- Desktop screen never yields mobile UA.
- Old clients without `seed` still work with `{ localeId, timezone }` only.

## Out of scope here

P2-8 UA build jitter. Full canvas-hash smoke requires a running CloakBrowser binary (manual).
