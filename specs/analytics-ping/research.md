# Research: Privacy-preserving anonymous usage telemetry for MultiZen

Status: research (spec-first step 0). No code yet.
Author: automated research pass.
Context: MultiZen is an OSS Electron anti-detect browser (Electron main, TypeScript monorepo; `apps/desktop`, `packages/settings-store`). Small user base (~tens of active, ~65 idle Discord, ~230 visits/mo mostly bots). Solo/tiny team, one Hetzner box, `getmultizen.com`. Audience is privacy/anti-tracking obsessed.

**Goal:** know roughly *how many people actively use it* plus a few aggregates (OS, app version, coarse country) **without being trackable**. Must be genuinely non-identifying, transparent, open-source-inspectable, and off-by-default or clearly disclosed + trivially disabled.

> Load-bearing tension up front: an anti-detect browser that "phones home" is a contradiction in ethos. For this audience the *default* and the *framing* matter more than the data. See §5 recommendation — the honest answer is "probably don't, or do the absolute minimum opt-out heartbeat," because at tens–hundreds of users the statistical signal is thin and GitHub download counts already give you most of it for free.

---

## 1. Counting active users without an identity

The core problem: "unique active users" normally implies a per-user identifier, and a persistent identifier *is* a tracking handle. The techniques below trade off simplicity vs. how much of a handle you keep.

### 1.1 Persistent random install-UUID — simplest, but a tracking handle
Generate a random UUID once, store it on disk, send it with every ping. Server counts distinct UUIDs. Trivial and accurate.

The problem: that UUID is a stable pseudonymous identifier that links every ping from one install forever. Under GDPR that is **pseudonymized, not anonymized**, and pseudonymized data is still personal data fully in scope of the regulation because it can be re-linked. Conflating the two is described as "one of the most common — and most consequential — compliance errors." ([hoop.dev](https://hoop.dev/blog/anonymous-analytics-gdpr-a-guide-to-privacy-first-data-insights/), [censinet](https://censinet.com/perspectives/gdpr-anonymization-documentation-key-requirements)) For an anti-detect audience a persistent UUID is exactly the "supercookie" they bought the product to avoid. **Reject this.**

### 1.2 Rotating daily salted hash — the privacy-first industry default
Don't send a stored ID at all. Derive an ephemeral daily identity server-side (or client-side) as:

```
daily_id = hash( coarse_signals || secret_daily_salt )
```

where `secret_daily_salt` rotates and is **discarded every 24h**, so yesterday's hashes cannot be recomputed or linked to today's. This is precisely what Plausible and Umami do:

- **Plausible:** "generates a daily hash from the visitor's IP, user agent, and a rotating salt, and purges the salt every 24 hours, making it impossible to reconstruct cross-day visitor chains." ([Plausible legal assessment](https://plausible.io/blog/legal-assessment-gdpr-eprivacy), [gdpranalytics.com](https://gdpranalytics.com/ip-anonymization-how-it-works-in-different-analytics-tools/))
- **Umami:** identifies unique visitors "using a hash of the hostname, user agent, and a rotating salt that resets daily"; the IP is only an in-memory input, never stored. ([umami.is](https://umami.is/), [analytics-alternatives](https://analytics-alternatives.com/tools/umami/))

Trade-off vs. UUID: you get **accurate same-day uniques** but **deliberately lose cross-day linkage** — you cannot follow one install over time, which is the whole point. Retention/"how many came back next week" becomes impossible by construction; you only get daily/period active counts.

Caveat for a desktop app: web tools hash `IP + user-agent` because those are what a browser exposes. A desktop client can instead hash a locally-generated random value that *rotates on the client each day* (never persisted across days), avoiding any dependency on IP for identity. Either way the salt/seed must be forgotten so the ID is ephemeral.

### 1.3 HyperLogLog cardinality estimation (server-side, no ID stored at all)
Instead of storing per-user rows and `COUNT(DISTINCT)`, feed each daily_id into a **HyperLogLog (HLL)** sketch and store only the sketch. HLL estimates set cardinality with ~0.81% standard error in ~12 KB regardless of volume, and Redis implements it natively (`PFADD`/`PFCOUNT`/`PFMERGE`). ([oneuptime](https://oneuptime.com/blog/post/2026-01-25-redis-hyperloglog-unique-visitors/view), [Google Cloud / HLL++](https://cloud.google.com/blog/products/gcp/counting-uniques-faster-in-bigquery-with-hyperloglog))

Why this is privacy-strong: the sketch is a lossy probabilistic structure — you keep the *count*, not the *members*. There is no row per user to leak, subpoena, or correlate. One HLL key per day (`uniq:2026-07-05`) plus `PFMERGE` gives weekly/monthly actives for free.

Technical gotcha, verified: to merge sketches across days you would need the **same** hash/salt, which conflicts with rotating the salt daily — "if different hash functions are used ... it will be seen as different users in each sketch." ([oneuptime](https://oneuptime.com/blog/post/2026-01-25-redis-hyperloglog-unique-visitors/view)) Resolution: keep the salt *stable within the aggregation window you care about* (e.g. one salt per day for DAU, and accept that WAU/MAU via `PFMERGE` will over-count a returning user as multiple uniques — which is actually the *more* privacy-preserving direction, since it means you genuinely cannot track a person across days). If you want honest de-duplicated MAU you must hold one salt for the whole month, which weakens cross-day unlinkability. This is a real, unavoidable privacy/accuracy dial — document whichever choice you make.

### 1.4 Not storing IP — derive coarse country, then discard
IP is personal data. The privacy-first pattern is: read the connection IP **in memory only**, map it to a coarse country (offline DB, see §4), and **never write the IP** to disk/logs. Plausible/Umami do exactly this — IP is a transient hash input, discarded. ([gdpranalytics.com](https://gdpranalytics.com/ip-anonymization-how-it-works-in-different-analytics-tools/), [piwik.pro](https://piwik.pro/blog/how-to-do-useful-analytics-without-personal-data/)) Country-only is coarse enough to stay non-identifying *in aggregate* (but see §3 k-anonymity risk for rare countries).

### 1.5 Differential-privacy-style approaches (probably overkill here)
Apple (RAPPOR-style local DP), Google's RAPPOR in Chrome, and Microsoft's Windows 10 telemetry add calibrated noise on-device so individual reports are deniable, with per-device daily "privacy budgets" (epsilon) capping information leakage. ([Apple "Learning with Privacy at Scale"](https://docs-assets.developer.apple.com/ml-research/papers/learning-with-privacy-at-scale.pdf), [Privacy Guides on DP](https://www.privacyguides.org/articles/2025/09/030/differential-privacy/), [stealthcloud](https://stealthcloud.ai/cryptography/differential-privacy/)) LDP shines at *internet scale* — its whole premise is that noise averages out over millions of reports. At tens–hundreds of users the noise would swamp the signal, so **local DP is the wrong tool at MultiZen's size.** Worth knowing for credibility; not worth building.

**Summary trade-off table**

| Method | Cross-day linkage | Storage | Re-identification risk | Fit for MultiZen |
|---|---|---|---|---|
| Persistent UUID | Full (forever) | 1 row/install | Pseudonymous = personal data | Reject |
| Rotating daily salted hash | None (by design) | 1 row/uniq/day | Very low | Strong |
| HyperLogLog sketch | None (count only) | 1 sketch/day (~12KB) | Effectively none | Strongest + cheapest |
| Local differential privacy | None | sketches | Provable bound | Overkill at this scale |

---

## 2. Prior art — how privacy-first OSS desktop apps do telemetry

**Syncthing (the closest analog: P2P, privacy-sensitive OSS desktop app).**
- Off by default; GUI asks **once**, shortly after first install. Reports on startup then every 24h via HTTPS POST; full payload viewable behind a "Preview" link before you consent. ([Syncthing security docs](https://docs.syncthing.net/users/security.html))
- Honest cautionary tale: their public dashboard (data.syncthing.net) turned out **not fully anonymous** — the country breakdown showed "1 user in Yemen," a textbook k-anonymity failure enabling de-anonymization; maintainers discussed adding differential privacy / k-anonymity. ([syncthing#7787](https://github.com/syncthing/syncthing/issues/7787)) **Direct lesson for MultiZen:** publishing rare-country counts re-identifies people. Threshold or bucket them (§3).

**Homebrew.** Anonymous analytics via InfluxDB. Key design detail worth copying: "Analytics are not enabled until after this notice is shown, to ensure that you can opt out without ever sending analytics data" — i.e. **no ping fires before the first-run disclosure**. Disable via `HOMEBREW_NO_ANALYTICS` env var. Justifies OS-version collection explicitly ("decide which versions of macOS to prioritise"). ([docs.brew.sh/Analytics](https://docs.brew.sh/Analytics), [Homebrew/brew#142 opt-in debate](https://github.com/Homebrew/brew/issues/142)) Note: Homebrew is *opt-out*, and it still draws criticism for it.

**Firefox.** Telemetry **on by default**, opt-out. Widely attacked as inconsistent with a "privacy-respecting" claim; community repeatedly asks for opt-in/zero-by-default. ([HN discussion](https://news.ycombinator.com/item?id=28494537), [Mozilla Connect idea](https://connect.mozilla.org/t5/ideas/opt-in-to-all-telemetry-zero-telemetry-by-default-reduced/idi-p/13223)) This is the reputational failure mode MultiZen must avoid.

**VS Code.** Opt-out, in-product notification for GDPR, but historically criticized that you "can opt out but not fully opt out," and the open-source community maintains de-telemetried builds (VSCodium). ([VS Code telemetry docs](https://code.visualstudio.com/docs/configure/telemetry)) Lesson: if you claim opt-out, the off switch must *actually* stop all network calls, or you'll get forked/shamed.

**Tor Browser.** The philosophical benchmark for this audience: **no telemetry, no user tracking, no persistent personal data transmitted.** The *only* routine call-home is the software **update check**, framed as a direct user benefit (you get security fixes), and even that is scrutinized. ([Tor privacy policy](https://www.torproject.org/about/privacy_policy/), [ritter.vg on telemetry](https://ritter.vg/blog-telemetry.html)) MultiZen already has this precedent: `apps/desktop/src/main/UpdaterService.ts` reaches `github.com/multizenteam/...releases`. An update check is far more defensible than analytics.

**Signal / Standard Notes.** Signal explicitly "doesn't collect analytics or telemetry data about how people are using Signal," retaining only account-creation and last-connection timestamps. ([Signal ToS/Privacy](https://signal.org/legal/)) The strongest privacy brands collect *nothing* and treat that as a feature. (Standard Notes similarly markets minimal collection; couldn't pull a primary source in this pass — **flag as unverified**.)

**Purpose-built tools you could adopt instead of hand-rolling:**
- **Aptabase** — OSS (server AGPLv3, SDKs MIT), privacy-first, **has an official Electron SDK** (`aptabase/aptabase-electron`). Explicitly "does not use device identifiers, cookies, fingerprinting nor long-term user identification"; sessions "completely anonymous and untraceable"; **self-hostable**. Closest turnkey fit. SDK does not auto-track — you call `trackEvent` yourself. ([aptabase GitHub](https://github.com/aptabase/aptabase), [aptabase-electron](https://github.com/aptabase/aptabase-electron), [aptabase.com/for-electron](https://aptabase.com/for-electron))
- **Plausible / Umami** — cookieless, daily-rotating-salt, no-IP-stored, self-hostable (Umami MIT, one Postgres container). Built for *web* pages, but the ingest endpoint is a plain POST you can hit from anywhere. ([umami.is](https://umami.is/), [danubedata self-host guide](https://danubedata.ro/blog/self-host-matomo-umami-google-analytics-alternative-2026))
- **PostHog / Countly** — heavyweight product analytics, self-hostable, EU cloud (PostHog Frankfurt eu-central-1), cookieless mode. Overkill for a heartbeat; also more surface area to audit, which hurts the "inspect it yourself" story. ([PostHog self-host](https://posthog.com/docs/self-host), [Countly](https://countly.com/blog/data-anonymization-explained-techniques-trade-offs-gdpr))

**Which are genuinely anonymous + self-hostable:** Aptabase, Umami, Plausible (self-hosted) all avoid persistent IDs and IP storage by design. PostHog/Countly can be configured anonymous but default to more. Syncthing/Homebrew are anonymous-*ish* but proven leaky at the rare-bucket tail.

---

## 3. What minimal aggregates are defensible

Target payload fields: **active-install signal, OS, app version, coarse country.** Field-by-field:

- **App version** — very low risk. Not user-specific; every user on that release shares it. Directly actionable (are people upgrading? do I still support 0.1.x?). Homebrew/Syncthing both collect it.
- **OS / OS family** — low risk *if coarse*. "macOS / Windows / Linux" or major version is fine; full build string (e.g. `macOS 15.3.1 (24D70)`) starts to narrow. Justifiable per Homebrew: decide which OS versions to prioritize. Prefer **OS family + major version only.**
- **Coarse country** — low risk *in aggregate for common countries*, but this is the field that bit Syncthing. Derive from IP then discard the IP (§1.4).
- **Active-install signal** — the rotating-daily-hash / HLL count (§1.2–1.3). No stored ID.

**The real risk is the *combination*, not any single field.** OS + OS-version + country + app-version is a **quasi-identifier tuple**. k-anonymity: each combination should be shared by at least *k* records; rare combinations (e.g. "Linux + app 0.1.0 + Yemen" = one person) are effectively identifying and must be **suppressed or generalized** (bucket to "Other", drop the OS minor, or coarsen country to region/continent) before storage or publication. ([k-anonymity overview, ScienceDirect](https://www.sciencedirect.com/topics/computer-science/k-anonymity), [mstrada k-anonymity/DP](https://mstrada.me/posts/k-anonymity)) Syncthing's "1 user in Yemen" is the concrete failure. ([syncthing#7787](https://github.com/syncthing/syncthing/issues/7787)) Practically: **never publish or store any cell with count < k (e.g. k = 20 or at least 5); collapse small countries into a region bucket.** At MultiZen's size *most* country cells will be tiny, so lean toward continent-level or "top-5 countries + Other."

**GDPR / consent implications for EU users:**
- **Truly anonymized aggregate data is out of scope of GDPR** — no consent needed — because it is no longer personal data. But the bar for "truly anonymized" is deliberately very high: identification must be impossible considering "all the means reasonably likely to be used," and **pseudonymized data (e.g. a persistent UUID or a re-linkable hash) is still personal data** in full scope. ([hoop.dev](https://hoop.dev/blog/anonymous-analytics-gdpr-a-guide-to-privacy-first-data-insights/), [censinet](https://censinet.com/perspectives/gdpr-anonymization-documentation-key-requirements))
- **ePrivacy angle:** Plausible's legal position is that (a) not storing anything on the device sidesteps ePrivacy Art. 5(3) consent, and (b) the processing rests on legitimate interest (Art. 6(1)(f)) because it does no profiling; after the daily salt is discarded "the remaining data does not allow any direct or indirect identification of persons." ([Plausible legal assessment](https://plausible.io/blog/legal-assessment-gdpr-eprivacy)) A desktop client storing a UUID on disk *does* write to the device — another reason to avoid the UUID.
- **Bottom line:** a no-persistent-ID, no-stored-IP, k-anonymized aggregate design has a credible claim to sit *outside* GDPR consent. But "credible claim" ≠ "certain" — this is a legal judgment, not a settled fact (**flag as needing legal review, not something I can guarantee**). The safe, audience-aligned move is to be conservative anyway: **off by default / explicit consent** removes the question entirely.

---

## 4. Concrete architecture on Hetzner + getmultizen.com

### Endpoint
`POST https://ping.getmultizen.com/ping` (or `/v1/ping`) behind the existing reverse proxy / a tiny service on the Hetzner box. TLS terminated at Caddy/nginx. No auth, no cookies, no redirects.

**Request body (the entire payload — nothing else, ever):**
```jsonc
{
  "v": "0.2.10",        // app version (from package.json)
  "os": "macos",        // family only: macos | windows | linux
  "osv": "15",          // OPTIONAL, major version only — consider dropping
  "ch": "stable"        // release channel, optional
}
```
Explicitly **NOT** in the payload: no UUID, no machine ID, no hostname, no username, no profile names, no proxy config, no IP (the client doesn't send it; the server sees the connection IP transiently), no MAC, no screen/hardware, no locale-as-fingerprint. The anti-detect nuance is absolute here: this endpoint must **never** learn anything about the user's profiles, proxies, or browsing.

### Deriving country then discarding IP
On the server, at request time:
1. Read connection IP from the socket **in memory only**.
2. Look up country via an **offline** DB — MaxMind **GeoLite2-Country** or DB-IP — so no third-party call and no IP leaves the box. (Do **not** reuse the client-side `ipapi.co` path in `apps/desktop/src/main/proxyGeo.ts`; that probes the *proxy's* geo for anti-detect matching and calls a third party — wrong tool, and you don't want to ship user IPs to ipapi.)
3. Coarsen: map to country, then **bucket rare countries → region/"Other"** (k-anonymity, §3).
4. **Discard the IP.** Never log it. Configure Caddy/nginx to **not log client IPs** for this vhost (`log` off or IP-redacted format) — the reverse proxy's default access log is the classic accidental-PII leak.

### Counting / storage
Ephemeral daily identity + HLL, so no per-user row exists:
- Client sends **no** ID. Server forms `daily_id = HMAC(secret_daily_salt, country || os || osv)` **only as an HLL input** — note this is coarse enough that it counts *distinct (country,os,version) buckets active today*, not distinct machines. To count distinct *machines* you need a per-client ephemeral value; the privacy-max option is to **not** count machines at all and instead count "pings received today" bucketed, accepting that a machine that pings once/day ≈ one machine.
- **Recommended concrete scheme:** client generates a **random 128-bit value that rotates each local day** (kept in memory / a file that is overwritten daily, never accumulated), sends it as `n` (nonce). Server does `PFADD uniq:<date> HMAC(daily_salt, n)` then **immediately forgets `n`**. `PFCOUNT uniq:<date>` = DAU. `PFMERGE` a week/month for WAU/MAU (with the over-count caveat from §1.3). Salt rotates daily and is discarded, so nothing links days.
- Aggregate breakdowns (version/os/country) are stored as **counters, not events**: `INCR count:<date>:<version>:<os>:<country_bucket>` in Redis, or one row per (date, dims, count) in SQLite/Postgres. Suppress cells < k before exposing.
- Storage sizing is trivial: Redis `better-sqlite3` is already a dep client-side; server can use Redis (HLL native) or a single SQLite file. At this scale SQLite + a nightly rollup is plenty; Redis HLL is the clean choice if Redis is already running.

### Client (Electron main)
- Add an opt setting to `AppSettings` in `packages/settings-store/src/index.ts`, e.g. `usageReporting: boolean` (**default `false`** — see §5). Mirrors the existing `autoUpdate` flag pattern.
- Fire **at most one ping per local calendar day** (a daily heartbeat, like Syncthing's 24h POST). Store only "last ping date" to rate-limit; that date is not sent.
- **Respect a kill switch env var** (`MULTIZEN_NO_TELEMETRY=1`) á la Homebrew, for CI/enterprise/paranoid users, checked before anything.
- **No ping before first-run disclosure** (Homebrew's rule): if using opt-out, the first launch must show the notice and only start pinging after the user has had the chance to decline in that same session.
- Fail silent, short timeout, no retry storms; a ping failure must never affect the browser.

### Why open-source makes this trustworthy
The entire ping path is in the repo: the exact payload, the "no IP sent," the daily-rotation, the off switch. A skeptical user can `grep` for the endpoint, read `UsageReporting.ts`, run the app behind Wireshark/mitmproxy and confirm the bytes match the code. This is the *only* thing that earns trust with an anti-detect audience — "trust us" is worthless; "read the 60 lines and watch the packets" is verifiable. Publish a short PRIVACY doc that mirrors Syncthing's "Preview payload" transparency.

---

## 5. Recommendation

### Opt-in vs opt-out for *this* audience
**Opt-in (default OFF).** Non-negotiable given the audience and the product category. An anti-detect browser is bought by people who are *specifically* hostile to call-home behavior; shipping opt-out telemetry (Firefox/Homebrew style) would be a brand-damaging, forkable, HN-front-page mistake regardless of how clean the payload is. The reputational cost dwarfs the analytics value. Follow Tor's posture: the only unprompted call-home is the update check you already have; anything else is explicit consent.

A defensible middle path if you want more signal: a **clear first-run screen** ("Help improve MultiZen? We send app version + OS + coarse country, once a day, no identifiers, no IP stored — [see exactly what] / [read the code]. You can turn this off anytime.") with the toggle **defaulting to off** and requiring an affirmative click. That's opt-in with good conversion, not dark-pattern opt-out.

### Exact minimal payload
```jsonc
{ "v": "0.2.10", "os": "macos", "osv": "15" }  // + ephemeral daily nonce "n" for counting; osv optional
```
Drop `osv` if you don't concretely need OS-version prioritization — every field you cut is one less argument.

### Counting method
**Rotating-salt daily hash → HyperLogLog server-side** (§1.2 + §1.3). Client sends a daily-rotating random nonce; server HMACs it with a daily-discarded salt into a per-day HLL sketch. DAU = `PFCOUNT`; WAU/MAU via `PFMERGE` with the documented over-count/unlinkability caveat. No per-user row, no stored IP, no cross-day linkage. Aggregate dims as suppressed counters (k ≥ 5, ideally 20; bucket rare countries).

### Smallest trustworthy implementation
1. One tiny service on Hetzner (`ping.getmultizen.com`), ~100 lines: parse 3-field JSON, GeoLite2 country lookup, `PFADD` + a few `INCR`, drop IP, proxy configured to not log IPs.
2. `UsageReporting.ts` in Electron main + a `usageReporting: boolean` (default false) in `AppSettings`, a settings toggle, `MULTIZEN_NO_TELEMETRY` env override, once-daily heartbeat, no pre-consent ping.
3. A public PRIVACY.md + a "Preview what's sent" affordance.
4. Consider skipping the build entirely and adopting **self-hosted Aptabase** (has the Electron SDK, is already audited/anonymous, AGPL server on your Hetzner box) — less code you have to make trustworthy, though it's more moving parts to run than 100 lines.

### Honest assessment: is it even worth it?
At **tens–hundreds** of active users, the statistical value is genuinely marginal:
- DAU/MAU will be small integers with high relative noise; HLL's own ~0.8% error is irrelevant next to the sampling noise of "we have ~40 users."
- Rare-cell suppression (k-anonymity) will blank out *most* country and OS-version breakdowns — you'll be left with "mostly Windows, some Mac, a few Linux; mostly US/EU," which you can already guess.
- **GitHub release download counts give you the trend for free, today, with zero privacy cost and zero user-trust cost.** They're aggregate, per-asset, per-platform (you can split win32/darwin/linux from asset names), anonymous, and already in `UpdaterService`'s reach. Limitations: totals are cumulative (diff snapshots yourself to get per-release deltas), inflated by bots/mirrors/CI, and not "active users" — but for "is usage growing and which OS dominates" they're adequate at this scale. ([GitHub download_count API](https://docs.github.com/en/rest/releases), [gh-release-stats](https://github.com/RamiAwar/gh-release-stats))

**My recommendation:** For now, **lean on GitHub download counts + Discord/website signals** and **do not ship telemetry yet**, or ship only the most minimal **opt-in daily heartbeat** (version + os, HLL count, no country even) purely to distinguish "installed once" from "still running." The extra fields (country, os-version) aren't worth the k-anonymity headache or the trust cost until you're at thousands of users where the aggregates become both meaningful and safely non-sparse. Revisit when active users cross ~1–2k.

---

## Recommended concrete design (one paragraph)
Ship an **opt-in, default-OFF** daily heartbeat. Payload: `{v, os}` (add `osv`/country only later, k-anonymized). No persistent ID, no IP sent; server derives country from the transient connection IP via offline GeoLite2 then discards it, and never logs IPs. Count uniques with a **daily-rotating client nonce → server daily-salt HMAC → Redis HyperLogLog**, salt discarded every 24h so days can't be linked. Suppress any published cell with count < 20 and bucket rare countries to regions. Gate everything behind a first-run consent screen (Homebrew's "no ping before the notice" rule) + a settings toggle in `AppSettings` + `MULTIZEN_NO_TELEMETRY` env kill switch. Keep the whole path in-repo and grep-able. **But first exhaust GitHub download counts** — at current scale they likely make the endpoint not worth building yet.

## Open questions
1. **Machine-unique vs bucket-unique count?** True distinct-machine DAU needs a per-client ephemeral nonce (design above). Are you OK with the WAU/MAU over-count that daily-salt rotation forces, or do you want honest de-dup MAU (which needs a month-long salt = weaker unlinkability)? Pick a point on that dial.
2. **Do you actually need country/OS-version?** Each adds k-anonymity risk and trust cost. What decision would they change?
3. **Legal:** the "anonymous → no consent" position (§3) is a credible argument, not a guarantee — worth a lawyer's eye before relying on it. I cannot certify GDPR compliance.
4. **Build vs adopt:** hand-rolled 100-line endpoint (max auditability, you run it) vs self-hosted Aptabase (pre-built, anonymous, more ops). Which matches your appetite for running services on the one Hetzner box?
5. **Standard Notes telemetry specifics** — asserted-minimal but I did not confirm from a primary source this pass. **Unverified.**

## Sources
- Syncthing: [security docs](https://docs.syncthing.net/users/security.html), [#7787 anonymization / Yemen](https://github.com/syncthing/syncthing/issues/7787), [#3628 usage reporting](https://github.com/syncthing/syncthing/issues/3628)
- Homebrew: [Analytics docs](https://docs.brew.sh/Analytics), [#142 opt-in debate](https://github.com/Homebrew/brew/issues/142)
- Aptabase: [server](https://github.com/aptabase/aptabase), [Electron SDK](https://github.com/aptabase/aptabase-electron), [for-electron](https://aptabase.com/for-electron)
- Plausible: [GDPR/ePrivacy legal assessment](https://plausible.io/blog/legal-assessment-gdpr-eprivacy)
- Umami: [umami.is](https://umami.is/), [overview](https://analytics-alternatives.com/tools/umami/), [self-host guide](https://danubedata.ro/blog/self-host-matomo-umami-google-analytics-alternative-2026)
- IP anonymization comparison: [gdpranalytics.com](https://gdpranalytics.com/ip-anonymization-how-it-works-in-different-analytics-tools/), [piwik.pro](https://piwik.pro/blog/how-to-do-useful-analytics-without-personal-data/)
- HyperLogLog: [Redis HLL unique visitors](https://oneuptime.com/blog/post/2026-01-25-redis-hyperloglog-unique-visitors/view), [BigQuery HLL++](https://cloud.google.com/blog/products/gcp/counting-uniques-faster-in-bigquery-with-hyperloglog)
- Cookieless counting / rotating salt: [WP Statistics](https://wp-statistics.com/resources/counting-unique-visitors-without-cookies/)
- GDPR anonymization: [hoop.dev](https://hoop.dev/blog/anonymous-analytics-gdpr-a-guide-to-privacy-first-data-insights/), [Censinet](https://censinet.com/perspectives/gdpr-anonymization-documentation-key-requirements)
- k-anonymity: [ScienceDirect overview](https://www.sciencedirect.com/topics/computer-science/k-anonymity), [mstrada](https://mstrada.me/posts/k-anonymity)
- Differential privacy: [Apple "Learning with Privacy at Scale"](https://docs-assets.developer.apple.com/ml-research/papers/learning-with-privacy-at-scale.pdf), [Privacy Guides](https://www.privacyguides.org/articles/2025/09/30/differential-privacy/), [stealthcloud](https://stealthcloud.ai/cryptography/differential-privacy/)
- Firefox telemetry: [HN](https://news.ycombinator.com/item?id=28494537), [Mozilla Connect](https://connect.mozilla.org/t5/ideas/opt-in-to-all-telemetry-zero-telemetry-by-default-reduced/idi-p/13223)
- VS Code telemetry: [docs](https://code.visualstudio.com/docs/configure/telemetry)
- Tor: [privacy policy](https://www.torproject.org/about/privacy_policy/), [ritter.vg on telemetry](https://ritter.vg/blog-telemetry.html)
- Signal: [ToS/Privacy](https://signal.org/legal/)
- PostHog/Countly: [PostHog self-host](https://posthog.com/docs/self-host), [Countly anonymization](https://countly.com/blog/data-anonymization-explained-techniques-trade-offs-gdpr)
- GitHub download counts: [gh-release-stats](https://github.com/RamiAwar/gh-release-stats)
