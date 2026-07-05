# MultiZen — Independent Growth & Monetization Verdict

**Date:** 2026-07-05 · Independent skeptical review (agent-produced, relayed by parent)
**Grounding verified in-repo:** issue #11 (`DNS_PROBE_FINISHED_NXDOMAIN`, Win10 LTSC, "local dns use", Russian sites broken); README confirms the proxy path relies on a "local SOCKS5 bridge so DNS resolution stays remote" and anti-detect score "~65/100 … past 90 with our own patches"; `specs/proxy-monetization/research.md` (provider/payout table); `specs/analytics-ping/research.md` (concluded "probably don't ship telemetry"); Pro = patched-Chromium, not yet shippable.

## Bottom line up front
The "add referrals now" lean is a **premature-optimization trap** (a mild one). At ~100–160 **flat** active installs, no monetization moves the needle — realized affiliate income is genuinely **$10–60/mo, mostly stuck under payout floors**. Meanwhile #11 **breaks the core proxy path on the ~60%-Windows base** while you're contemplating recommending proxies. Next 1–3 months: **(1) fix the proxy/DNS core, (2) lean into the LLM/MCP acquisition channel that already works, (3) monetization waits** — except one afternoon of static referral links. This is pre-PMF; act like it.

## 1. Active-user estimate & trajectory
**~100–160 active installs, flat. Plan around ~120.** The load-bearing signal is `latest.yml` polls: v0.2.9 = **162** (current ~10 days), v0.2.10 = **161** (current ~7 days). Two independent ~1-week windows landing at the same ~160 ⇒ **acquisition ≈ churn; the base is flat, not growing.**

Is latest.yml a fair proxy? **Directionally yes, treat as a ceiling.** electron-updater fetches the newest release's `latest.yml` per-launch + periodically, so multi-launch installs over-count; offline/auto-update-disabled installs under-count. Net true distinct actives ~100–160.

The per-release installer curve (168/149 → 55 → 125 → **87**) is **not decay** — it's confounded by **days-since-release** (v0.2.10 has only ~7 days of accrual) and by the launch-marketing beat. The real number is the funnel: **~651 gross installers → ~160 pollers ≈ 25% survive to "still running."** That **~75% download→active evaporation** is the most important figure here.

**Pre-PMF? Yes, clearly** — flat ~160, 75% drop-off, 113 stars, 17 forks, 1 open issue, ~65 *idle* Discord, ~100 uniques/14d. (Legacy 0.1.1's 8,258 excluded as irrelevant.)

## 2. Referrals vs own-billing vs Pro
**Own-proxy-billing: premature, not close.** A whole business unit (payments, KYC/fraud, supply contracts, refunds, support) for unproven demand — and it maximally collides with the anti-detect audience's unwillingness to hand you a card + logs. Don't.

**Affiliate now — honestly quantified, it's a rounding error.** Anti-detect users usually *already own proxies*, so addressable click-through is a minority of the base. Generous funnel (8% click ≈ 10 people → 30% convert ≈ 3 → $50–150 LTV) ≈ **$75–250 total first-purchase commissions over months**. Then payout minimums subtract: NodeMaven **$100 crypto-only**, Infatica $100 — you may accrue and never get paid. Only Webshare ($10 PayPal weekly) / SOAX / Decodo ($10) actually pay at your volume. **Realized ≈ $10–60/mo, mostly trapped.** Below the noise floor of a $2–4k/yr op.

**Distraction test:** an **in-app curated section with hosted JSON + compare UI** = multi-day build + ongoing maintenance for <$60/mo *while the proxy core is broken on 60% of installs* → fails the test. **But** a **static `RECOMMENDED-PROXIES.md` with 3–5 links, no billing, no in-app UI** is an afternoon and captures the "you need a proxy — here's who we trust" onboarding moment. Ship that, then stop.

**Third option — Pro license — is the strategically correct lever, and it beats proxy affiliate on intent alignment:** someone who installs an anti-detect browser will pay for *better anti-detection* (patched Chromium, 65→90+) far more readily than they'll re-buy proxies through your link. At 120 active, 4% × $49 ≈ **$235 one-time, on-brand, no third-party payout floors** vs affiliate's gated $10–60/mo. **Catch: Pro isn't shippable this quarter** (patched-Chromium pipeline incomplete). So of the two, **Pro is the build-toward, affiliate is the stub-and-ignore.**

## 3. Where effort goes
**3a — Fix #11 first, not close.** README's design = per-profile proxy with remote DNS via a local SOCKS5 bridge; #11 is a failure in exactly that path, on **Windows (~60% of base)**. The product isn't doing its one job for the majority platform — almost certainly feeding the 75% churn — and it's darkly ironic to build "recommended proxies" while your own proxy routing NXDOMAINs. **Highest-leverage item here.**

**3b — Lean hard into the LLM/MCP channel.** Referrers include **chatgpt.com and claude.ai** — LLMs recommend MultiZen unprompted, and the product's thesis is a local MCP server for agents. Being surfaced *by the agents* is the most on-thesis signal in the dataset: free, compounding, validates the pivot. Cheap moves: list in **MCP registries / awesome-mcp / tool ecosystems**; make the repo **LLM-legible** (crisp "MCP browser for agents" README, copy-paste MCP config, tool list).

**3c — Wake the base you have.** 65 idle Discord + Reddit + ~100 uniques doing nothing. 1 open issue = low engagement. One founder asking "what's broken / what would make you use this daily?" out-informs any telemetry.

Suggested quarter split: **~60% product (fix #11 + proxy reliability), ~30% acquisition (MCP/LLM + wake base), ~10% monetization (static links, then stop).**

## 4. Free growth dashboard (no telemetry — agrees with analytics-ping conclusion)
Weekly, all free APIs:
- **Active-install proxy** = current-release `latest.yml` polls — **North Star** (flat vs rising).
- **Release download velocity** = installers normalized to **first-7-day window** (kills days-since-release confound).
- **Download→active survival** = latest.yml ÷ gross installers (watch it improve after #11).
- **Traffic + referrer mix** — watch **LLM referrers trend** = agent-thesis validation.
- **Platform split trend** (per-asset counts) — catches platform-specific breakage like #11.
- **Stars/forks slope; issue count + time-to-first-response; Discord members + weekly active.**

Two honesty rules: **normalize by days-since-release** before comparing releases; **snapshot the 14-day traffic/referrer data weekly to a flat file** (GitHub discards it after 14d). Build cost: one scheduled GitHub-API script + a manual Discord number.

## 5. 1–3 month plan
1. **Product/bugfix (#11 + proxy reliability)** — dominant.
2. **Acquisition (MCP/LLM channel + wake base).**
3. **Monetization** — deprioritized to one afternoon of static referral links, frozen until active installs rise and/or Pro is shippable.

Weeks 1–3 — reproduce+fix #11, ship, verify proxy+remote-DNS on Win/mac/Linux, announce as re-engagement. Weeks 2–4 — stand up the §4 dashboard. Weeks 3–6 — MCP-channel push; track LLM-referrer trend. Ship the static referral doc; ignore thereafter. Keep advancing patched-Chromium (Pro). **Gate at ~month 3:** installs clearly rising + LLM referrers growing → invest in Pro launch; still flat at ~160 → still a product/positioning problem.

**Push-back restated:** the prior "start affiliate now" rec isn't wrong so much as **mis-sequenced and over-scoped**. At ~120 active installs you don't have a monetization problem — you have a **retention-and-acquisition problem wearing a monetization costume.**

**Caveats:** electron-updater semantics inferred (not code-verified); affiliate funnel numbers deliberately generous; Pro 4% illustrative and not shippable this quarter; #11 severity inferred — confirm the SOCKS-bridge code path when fixing; legacy 0.1.1 excluded throughout.
