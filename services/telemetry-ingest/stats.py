#!/usr/bin/env python3
"""
Read-only stats for the MultiZen telemetry ingest. Run on the server:

    /opt/multizen-telemetry/venv/bin/python stats.py

Prints daily/weekly/monthly active machines (HyperLogLog estimates) and the
version/OS breakdown. Suppresses breakdown cells below a k threshold so a rare
combination can't single anyone out.
"""
import os
from datetime import datetime, timedelta, timezone

import redis

REDIS_URL = os.environ.get("MZ_TELEMETRY_REDIS", "redis://127.0.0.1:6379/2")
K_SUPPRESS = 5  # hide breakdown cells below this many

r = redis.from_url(REDIS_URL)


def day(offset: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=offset)).strftime("%Y-%m-%d")


def active(days: int) -> int:
    keys = [f"uniq:{day(i)}" for i in range(days)]
    keys = [k for k in keys if r.exists(k)]
    if not keys:
        return 0
    tmp = "uniq:_tmp_stats"
    r.pfmerge(tmp, *keys)
    n = r.pfcount(tmp)
    r.delete(tmp)
    return n


print(f"DAU (today):      {r.pfcount('uniq:' + day(0)) if r.exists('uniq:' + day(0)) else 0}")
print(f"WAU (7 days):     {active(7)}")
print(f"MAU (30 days):    {active(30)}")

print("\nToday by version/os (cells <", K_SUPPRESS, "suppressed):")
today = day(0)
rows = []
for key in r.scan_iter(match=f"count:{today}:*"):
    label = key.decode().split(":", 2)[2]
    n = int(r.get(key))
    rows.append((label, n))
for label, n in sorted(rows, key=lambda x: -x[1]):
    print(f"  {'(suppressed)' if n < K_SUPPRESS else n:>12}  {label}")
if not rows:
    print("  (no pings today)")
