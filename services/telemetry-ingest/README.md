# MultiZen telemetry ingest

The server side of the opt-in anonymous heartbeat. Receives
`POST /ping {v, os, n}`, counts distinct machines per day with a Redis
HyperLogLog, and keeps coarse `(version, os)` counters — no per-user row, no
stored nonce, no IP. See `../../docs/TELEMETRY.md` for the full contract.

- `server.py` — the ingest (Python stdlib HTTP + redis-py), binds `127.0.0.1:8787`.
- `stats.py` — read-only DAU/WAU/MAU + breakdown.
- `multizen-telemetry.service` — systemd unit.
- `Caddyfile.snippet` — the vhost to append (TLS + IP-less logging).
- `requirements.txt` — `redis`.

## Deploy (chosen host: 185.2.103.238, Ubuntu 24.04, Caddy already present)

Deployment is git-based (no rsync). Run as root:

```sh
# 1. Dedicated user + layout
useradd --system --home /opt/multizen-telemetry --shell /usr/sbin/nologin mztel || true
install -d -o mztel -g mztel /opt/multizen-telemetry

# 2. Clone the repo (public) — the service lives under services/telemetry-ingest
git clone --depth 1 https://github.com/multizenteam/multizen-browser \
  /opt/multizen-telemetry/repo
chown -R mztel:mztel /opt/multizen-telemetry/repo

# 3. Local Redis (own instance; NOT shared with the fapboo container)
apt-get update && apt-get install -y redis-server python3-venv
# redis-server ships bound to 127.0.0.1 and systemd-managed by default.
# Backstop against junk-key growth from a flood of spoofed pings: cap memory
# and evict by TTL (every key we write has one). Belt-and-suspenders with the
# 90-day key TTL in server.py.
sed -i 's/^# maxmemory <bytes>/maxmemory 128mb/; s/^# maxmemory-policy noeviction/maxmemory-policy volatile-ttl/' /etc/redis/redis.conf
grep -q '^maxmemory ' /etc/redis/redis.conf || printf '\nmaxmemory 128mb\nmaxmemory-policy volatile-ttl\n' >> /etc/redis/redis.conf
systemctl restart redis-server

# 4. Python venv + deps
python3 -m venv /opt/multizen-telemetry/venv
/opt/multizen-telemetry/venv/bin/pip install -r \
  /opt/multizen-telemetry/repo/services/telemetry-ingest/requirements.txt
chown -R mztel:mztel /opt/multizen-telemetry/venv

# 5. systemd service
cp /opt/multizen-telemetry/repo/services/telemetry-ingest/multizen-telemetry.service \
  /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now multizen-telemetry
systemctl status --no-pager multizen-telemetry
curl -s localhost:8787/healthz   # -> {"ok": true, ...}

# 6. Caddy vhost (append the snippet, validate, reload — does NOT touch other sites)
cat /opt/multizen-telemetry/repo/services/telemetry-ingest/Caddyfile.snippet >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile   # abort if this fails
systemctl reload caddy
```

Verify end to end from anywhere:

```sh
curl -s https://ping.getmultizen.com/healthz
curl -s -X POST https://ping.getmultizen.com/ping \
  -H 'content-type: application/json' \
  -d '{"v":"0.2.12","os":"linux","n":"00112233445566778899aabbccddeeff"}'
# -> {"ok": true}
```

## Updating

```sh
git -C /opt/multizen-telemetry/repo pull --ff-only
systemctl restart multizen-telemetry
# only re-run pip install if requirements.txt changed
```

## Reading numbers

```sh
sudo -u mztel /opt/multizen-telemetry/venv/bin/python \
  /opt/multizen-telemetry/repo/services/telemetry-ingest/stats.py
```
