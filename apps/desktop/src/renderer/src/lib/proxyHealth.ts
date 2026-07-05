/**
 * Live proxy health for profile cards. Wraps `window.multizen.proxy.detectGeo`
 * (probes ipapi.co through the profile's proxy) behind a small module-level
 * cache so the same probe result is shared across every card that shows the
 * profile, survives remounts within a TTL, and — critically — a cold app open
 * with many proxied profiles doesn't fire N simultaneous external probes.
 *
 * States surfaced to the card: `direct` (no proxy), `checking` (probe queued or
 * in flight), `ok` (egress geo resolved), `error` (probe failed — offers retry).
 * The last-known country code (from the DB `proxyCountry`) is carried through
 * `checking`/`error` so the flag doesn't flicker away while re-probing.
 */
import { useCallback, useEffect, useState } from "react";
import type { ProxyConfig } from "../types";

export type ProxyHealth =
  | { status: "direct" }
  | { status: "checking"; cc?: string }
  | { status: "ok"; cc?: string; country?: string; ip?: string }
  | { status: "error"; error: string; cc?: string };

interface Entry {
  health: ProxyHealth;
  /** epoch ms of the last resolved (ok/error) probe; 0 while never resolved. */
  ts: number;
  /** proxy identity this entry describes — invalidates on host/port change. */
  key: string;
}

/** Re-probe a proxy at most this often on mount; a manual retry ignores it. */
const TTL = 5 * 60 * 1000;

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
// The proxy each mounted card currently WANTS probed. Set by the hook effect;
// read when a probe finishes so that a probe started for an old proxy — still
// in flight when the proxy changed — is superseded by a fresh probe for the new
// one instead of leaving the card stuck on "checking".
const wanted = new Map<string, { proxy: ProxyConfig; cc?: string; key: string }>();

// Concurrency-limited queue: opening the app with many proxied profiles must
// not hammer ipapi.co / the proxies with a thundering herd of probes.
const MAX_CONCURRENT = 3;
let active = 0;
const queue: Array<() => void> = [];

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    if (!job) break;
    active++;
    job();
  }
}

function runQueued(job: () => Promise<void>): void {
  queue.push(() => {
    void job().finally(() => {
      active--;
      pump();
    });
  });
  pump();
}

function keyOf(proxy: ProxyConfig): string {
  // Include credentials: an auth fix (password only) must invalidate a cached
  // ok/error so the row re-probes rather than showing a stale auth status.
  return `${proxy.type}://${proxy.username ?? ""}:${proxy.password ?? ""}@${proxy.host}:${proxy.port}`;
}

function notify(profileId: string): void {
  const set = listeners.get(profileId);
  if (set) for (const fn of set) fn();
}

function probe(profileId: string, proxy: ProxyConfig, lastCc?: string): Promise<void> {
  const existing = inFlight.get(profileId);
  if (existing) return existing;

  const key = keyOf(proxy);
  // Optimistic "checking" — keep the last-known cc so the flag stays put.
  cache.set(profileId, { health: { status: "checking", cc: lastCc }, ts: 0, key });
  notify(profileId);

  const p = new Promise<void>((resolve) => {
    runQueued(async () => {
      let health: ProxyHealth;
      try {
        const res = await window.multizen.proxy.detectGeo(proxy, profileId);
        health = res.ok
          ? { status: "ok", cc: res.geo.country, country: res.geo.countryName, ip: res.geo.ip }
          : { status: "error", error: res.error, cc: lastCc };
      } catch (e) {
        health = { status: "error", error: e instanceof Error ? e.message : String(e), cc: lastCc };
      }
      cache.set(profileId, { health, ts: Date.now(), key });
      notify(profileId);
      resolve();
    });
  }).finally(() => {
    inFlight.delete(profileId);
    // If the card now wants a different proxy than the one we just probed
    // (changed mid-flight), supersede it with a fresh probe so it can't stick
    // on "checking".
    const w = wanted.get(profileId);
    if (w && w.key !== key) {
      void probe(profileId, w.proxy, w.cc);
    }
  });

  inFlight.set(profileId, p);
  return p;
}

/**
 * Subscribe a card to its profile's proxy health. Auto-probes on mount when the
 * cached result is missing or stale (or the proxy changed); `recheck()` forces a
 * fresh probe regardless of TTL.
 */
export function useProxyHealth(
  profileId: string,
  proxy: ProxyConfig | undefined,
  proxyCountry: string | undefined,
): { health: ProxyHealth; recheck: () => void } {
  const [, force] = useState(0);

  const key = proxy ? keyOf(proxy) : "";

  useEffect(() => {
    if (!proxy) return;
    const rerender = (): void => force((n) => n + 1);
    let set = listeners.get(profileId);
    if (!set) {
      set = new Set();
      listeners.set(profileId, set);
    }
    set.add(rerender);
    // Record what this card wants probed so a probe for a superseded proxy
    // (still in flight when the proxy changed) can re-fire for the new one.
    wanted.set(profileId, { proxy, cc: proxyCountry, key });

    const cached = cache.get(profileId);
    const fresh =
      cached && cached.key === key && cached.ts > 0 && Date.now() - cached.ts < TTL;
    if (!fresh && !inFlight.has(profileId)) {
      void probe(profileId, proxy, proxyCountry);
    }

    return () => {
      set.delete(rerender);
      if (set.size === 0) {
        listeners.delete(profileId);
        wanted.delete(profileId);
      }
    };
    // proxyCountry intentionally excluded: it seeds the flag but shouldn't
    // retrigger a probe on its own (the probe itself refreshes it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, key]);

  const recheck = useCallback(() => {
    if (proxy && !inFlight.has(profileId)) {
      // Prefer the last-resolved cc over the (possibly older) DB country so a
      // manual re-check doesn't flicker the flag back to a stale value.
      const h = cache.get(profileId)?.health;
      const lastCc = (h && "cc" in h ? h.cc : undefined) ?? proxyCountry;
      void probe(profileId, proxy, lastCc);
    }
  }, [profileId, proxy, proxyCountry]);

  if (!proxy) return { health: { status: "direct" }, recheck };

  const cached = cache.get(profileId);
  // Ignore a cached entry from a previous proxy identity (host/port changed).
  const health: ProxyHealth =
    cached && cached.key === key ? cached.health : { status: "checking", cc: proxyCountry };
  return { health, recheck };
}
