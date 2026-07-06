#!/usr/bin/env python3
"""
MultiZen telemetry ingest — the smallest trustworthy implementation.

Receives the opt-in daily heartbeat the desktop app sends (see
apps/desktop/src/main/UsageReporting.ts and docs/TELEMETRY.md) and counts it
without ever storing a per-user identifier or an IP.

Endpoint:  POST /ping   body: {"v": "<version>", "os": "<family>", "n": "<32-hex nonce>"}
           GET  /healthz

Privacy:
  - The only thing counted is a daily HyperLogLog of the single-use nonces
    (distinct machines per day) plus coarse (version, os) counters. No row per
    user, no stored nonce, no IP. v1 does NOT derive country (dropped to avoid
    GeoLite2 + k-anonymity risk at low volume; add later if needed).
  - The connection IP is never read, never logged. Caddy in front is configured
    to not log client IPs either.
  - Keys carry a TTL so data self-expires.

Runs behind Caddy (TLS) on 127.0.0.1. Managed by systemd. Redis is a local
instance (not shared with other apps).
"""
import json
import os
import re
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import redis  # redis-py; installed in the service venv

HOST = os.environ.get("MZ_TELEMETRY_HOST", "127.0.0.1")
PORT = int(os.environ.get("MZ_TELEMETRY_PORT", "8787"))
REDIS_URL = os.environ.get("MZ_TELEMETRY_REDIS", "redis://127.0.0.1:6379/0")
MAX_BODY = 4096  # a valid ping is ~80 bytes
KEY_TTL_SECONDS = 400 * 24 * 60 * 60  # ~13 months, then self-expire

OS_FAMILIES = {"macos", "windows", "linux", "other"}
VERSION_RE = re.compile(r"^\d{1,4}(\.\d{1,4}){0,3}(-[0-9A-Za-z.]{1,20})?$")
NONCE_RE = re.compile(r"^[0-9a-f]{32}$")

_r = redis.from_url(REDIS_URL, socket_timeout=2)


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _record(v: str, os_family: str, nonce: str) -> None:
    day = _today()
    uniq_key = f"uniq:{day}"
    count_key = f"count:{day}:v={v}:os={os_family}"
    pipe = _r.pipeline()
    pipe.pfadd(uniq_key, nonce)  # HLL: distinct machines today (nonce not stored)
    pipe.expire(uniq_key, KEY_TTL_SECONDS)
    pipe.incr(count_key)
    pipe.expire(count_key, KEY_TTL_SECONDS)
    pipe.execute()


class Handler(BaseHTTPRequestHandler):
    # Silence the default access logger entirely — it prints client IPs.
    def log_message(self, *args) -> None:  # noqa: D401, ANN002
        return

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._json(200, {"ok": True, "name": "multizen-telemetry"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/ping":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self._json(400, {"error": "bad length"})
            return
        if length <= 0 or length > MAX_BODY:
            self._json(400, {"error": "bad body size"})
            return

        raw = self.rfile.read(length)
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            self._json(400, {"error": "invalid json"})
            return
        if not isinstance(data, dict):
            self._json(400, {"error": "invalid payload"})
            return

        v = data.get("v")
        os_family = data.get("os")
        nonce = data.get("n")
        if (
            not isinstance(v, str)
            or not VERSION_RE.match(v)
            or os_family not in OS_FAMILIES
            or not isinstance(nonce, str)
            or not NONCE_RE.match(nonce)
        ):
            # Reject anything off-shape; do not record partial/garbage pings.
            self._json(400, {"error": "invalid fields"})
            return

        try:
            _record(v, os_family, nonce)
        except redis.RedisError:
            # Never leak internals; a storage hiccup shouldn't 500-storm clients.
            self._json(503, {"error": "unavailable"})
            return
        self._json(200, {"ok": True})


def main() -> int:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    sys.stdout.write(f"multizen-telemetry listening on {HOST}:{PORT}\n")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
