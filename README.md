<div align="center">
  <img src=".github/assets/logo.png" width="96" height="96" alt="MultiZen" />

  <h1>MultiZen</h1>

  <p><strong>A browser library for AI agents and human operators.</strong></p>

  <p>
    Local Chromium profiles with their own cookies, fingerprint, and proxy.<br/>
    Drive them through MCP from Cursor, Claude Desktop, or any MCP client.<br/>
    Step in manually whenever the agent hits a CAPTCHA or 2FA prompt.
  </p>

  <p>
    <a href="https://github.com/multizenteam/multizen-browser/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/multizenteam/multizen-browser?style=for-the-badge&color=8b5cf6&labelColor=0a0b0f"></a>
    <a href="https://github.com/multizenteam/multizen-browser/blob/master/LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/multizenteam/multizen-browser?style=for-the-badge&color=ec4899&labelColor=0a0b0f"></a>
    <a href="https://github.com/multizenteam/multizen-browser/actions/workflows/release.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/multizenteam/multizen-browser/release.yml?style=for-the-badge&labelColor=0a0b0f"></a>
    <a href="https://github.com/multizenteam/multizen-browser/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/multizenteam/multizen-browser/total?style=for-the-badge&color=3b82f6&labelColor=0a0b0f"></a>
    <a href="https://github.com/multizenteam/multizen-browser/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/multizenteam/multizen-browser?style=for-the-badge&color=ff6b35&labelColor=0a0b0f"></a>
    <a href="https://discord.gg/pd6MhzPbJ3"><img alt="Discord" src="https://img.shields.io/badge/discord-join-5865f2?style=for-the-badge&labelColor=0a0b0f"></a>
  </p>

  <p>
    <a href="https://getmultizen.com"><strong>getmultizen.com</strong></a>
    &nbsp;·&nbsp;
    <a href="https://github.com/multizenteam/multizen-browser/releases/latest">Download</a>
    &nbsp;·&nbsp;
    <a href="https://discord.gg/pd6MhzPbJ3">Discord</a>
  </p>

  <br/>

  <img src=".github/assets/profiles-list.jpg" alt="MultiZen profile library with platform, proxy country, and AI-activity indicators" width="100%" />

  <br/><br/>
</div>

## What it is

MultiZen is a desktop app that runs a library of isolated Chromium browser profiles. Each profile has its own cookies, login state, fingerprint, and proxy. A local MCP server on `localhost:7777` exposes browser-drive tools (navigate, click, type, extract, screenshot) to any MCP client.

The result: your AI agent in Cursor or Claude Desktop can complete real authenticated workflows. When it hits a 2FA prompt or CAPTCHA, you step in through the same Chromium window. When you are done, the agent picks up where it left off. Cookies and session state survive between launches.

## Install

### macOS

The cleanest path. Homebrew handles the Gatekeeper quarantine for you:

```sh
brew tap multizenteam/multizen
brew install --cask multizen
```

Or grab the DMG straight from the [releases page](https://github.com/multizenteam/multizen-browser/releases/latest) and run this once after install to bypass the unsigned-app warning:

```sh
xattr -cr /Applications/MultiZen.app
```

### Linux

```sh
curl -LO https://github.com/multizenteam/multizen-browser/releases/latest/download/MultiZen-linux-x86_64.AppImage
chmod +x MultiZen-linux-x86_64.AppImage
./MultiZen-linux-x86_64.AppImage
```

Some distros need `libfuse2` (`apt install libfuse2t64` on Ubuntu 24.04+). If Chromium's sandbox refuses to start, add `--no-sandbox`.

### Windows

Download [MultiZen-win-x64.exe](https://github.com/multizenteam/multizen-browser/releases/latest/download/MultiZen-win-x64.exe). SmartScreen may flag the installer as unrecognized on first download. Click **More info**, then **Run anyway**.

### One-liner installer

For macOS and Linux:

```sh
curl -sSL https://getmultizen.com/install.sh | bash
```

## How it works

```
+----------------------+         +-----------------------+
|  Cursor / Claude     |  MCP    |  MultiZen Desktop App |
|  Desktop / Cline     | <-----> |  localhost:7777       |
+----------------------+         +-----------+-----------+
                                             |
                                             | spawn / drive (CDP)
                                             v
                              +--------------+--------------+
                              |  Profile A  |  Profile B  | ...
                              |  cookies    |  cookies    |
                              |  proxy LU   |  proxy US   |
                              |  Win 145    |  macOS 145  |
                              +-------------+--------------+
                                            |
                                            v
                                  patched Chromium binary
                                  (canvas, WebGL, audio,
                                   font, WebRTC fingerprints
                                   spoofed at C++ level)
```

Each profile is a real Chromium window with persistent state on disk. The MCP server speaks the standard Anthropic Model Context Protocol over Streamable HTTP (plus legacy SSE) so it works with any client. Browser-drive tools call into Chrome DevTools Protocol under the hood.

## Features

|  | What it does |
| --- | --- |
| **MCP server** | Native localhost endpoint. Works with Cursor, Claude Desktop, Cline, Continue, anything else that speaks MCP. |
| **Anti-detect Chromium** | Source-patched browser engine (CloakBrowser). Canvas, WebGL, audio, fonts, WebRTC IP all spoofed at C++ level instead of JS injection. |
| **Persistent state** | Cookies, login, IndexedDB, localStorage stay per-profile across launches and across AI sessions. |
| **Human handoff** | AI gets stuck on 2FA or CAPTCHA, you take over in the same Chromium window, the agent continues when you are done. |
| **Cross-platform persona** | Run a Windows persona on a Mac host (or vice versa). C++ patches keep the fingerprint coherent across V8, Blink, and CSS feature signatures. |
| **Proxy + persona alignment** | Per-profile HTTP or SOCKS5 proxy with a local SOCKS5 bridge so DNS resolution stays remote. Auto-aligns timezone, locale, and `navigator.geolocation` to the proxy egress IP. |
| **Self-hosted** | Profiles live on your disk in plain SQLite plus Chromium user-data-dir format. No account, no license server, no telemetry. |
| **Open source** | MIT for the entire app, MCP server, and CDP driver. Patched Chromium engine is also open source. |

## Onboarding

<div align="center">
  <img src=".github/assets/firstrun.jpg" alt="MultiZen first-run onboarding" width="85%" />
</div>

## Connect an agent (Codex, Cursor, Claude Desktop)

After installing, the MCP server starts on `localhost:7777`. It serves the current
**Streamable HTTP** transport at `http://localhost:7777/mcp` (plus a legacy HTTP+SSE
endpoint at `/sse` for older clients). Add it to your client config.

**Codex CLI** (`~/.codex/config.toml`) — connects to Streamable HTTP directly:

```toml
[mcp_servers.multizen]
url = "http://localhost:7777/mcp"
```

**JSON URL clients — Cursor** (`~/.cursor/mcp.json`), Cline, Continue:

```json
{
  "mcpServers": {
    "multizen": {
      "url": "http://localhost:7777/mcp"
    }
  }
}
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS)
— its config has no `url` field, so bridge the endpoint through
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) (needs Node):

```json
{
  "mcpServers": {
    "multizen": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:7777/mcp"]
    }
  }
}
```

Restart your client. The agent now has tools: `list_profiles`, `launch_profile`, `close_profile`, `navigate`, `click`, `type`, `extract`, `screenshot`.

## Honest limits

What isn't handled yet — and where each is headed. No "100% undetectable" claims here.

- **TLS fingerprint** isn't spoofed yet: the most aggressive stacks (some Cloudflare Enterprise setups, DataDome) fingerprint JA3/JA4 at the TLS layer, below the browser. → Addressed by the patched-Chromium engine on the [roadmap](#roadmap).
- **Behavioral signals** aren't shaped: mouse paths, timing, and scroll are unmodeled, and an agent driving the DOM moves linearly — detectable. → Behavioral injection is on the [roadmap](#roadmap).
- **Anti-detect score** is ~65/100 on fingerprint-scan.com over a residential proxy — the CloakBrowser ceiling without our own patches. → The patched engine lifts this past 90.
- **Parallelism** targets ~30–50 profiles per machine, not fleets. For 500 concurrent browsers, use Browserbase or Hyperbrowser.

## Stack

| Layer | Tech |
| --- | --- |
| Desktop shell | Electron 33 |
| Renderer | React 19, Tailwind v4, TypeScript strict |
| Main process | TypeScript ESM, electron-vite, native MCP SDK |
| MCP server | `@modelcontextprotocol/sdk` over Streamable HTTP + SSE |
| Profile storage | better-sqlite3 with idempotent migrations |
| Browser driver | chrome-remote-interface over CDP |
| Browser engine | CloakBrowser (open-source patched Chromium) |
| Build | Yarn 4 workspaces, electron-vite, electron-builder |
| CI | GitHub Actions matrix on macOS, Windows, Linux |

## Develop

```sh
git clone https://github.com/multizenteam/multizen-browser
cd multizen-browser
yarn install
yarn dev            # launch the desktop app in dev mode
yarn mcp:dev        # run the MCP server standalone for testing
yarn typecheck      # strict TS across all workspaces
yarn build          # full release build (mac/win/linux per OS)
```

Requires Node 22+ and Yarn 4 (via Corepack).

## Repo layout

```
apps/
  desktop/                Electron + React + Tailwind GUI + main process
packages/
  mcp-server/             MCP server exposing the browser-drive tools
  cdp-driver/             Thin wrapper around chrome-remote-interface
  profile-manager/        SQLite profile CRUD + encrypted local storage
  settings-store/         App-level settings persistence
  types/                  Shared TypeScript types
.github/
  workflows/release.yml   Matrix build, tag-triggered
```

## Roadmap

Things landing in upcoming releases.

- **multizen-pro patched Chromium**: TLS JA3/JA4 spoof, HTTP/2 SETTINGS fingerprint, native Sec-CH-UA-* overrides. Bumps the anti-detect ceiling well past 90/100 on fingerprint-scan.
- **Behavioral injection**: humanized mouse paths, keystroke timing, scroll jitter applied at the CDP input layer.
- **Per-profile cloud sync** (opt-in, end-to-end encrypted): so the same profile follows you across laptops.
- **Team workspaces**: shared profile pool with audit log.

## Why MultiZen vs the alternatives

| | MultiZen | Browserbase / Hyperbrowser | GoLogin / AdsPower / Multilogin |
| --- | :---: | :---: | :---: |
| Native MCP server | yes | yes | profile CRUD only |
| Drives the browser through MCP | yes | yes | no |
| Anti-detect at C++ level | yes | partial | yes |
| Persistent login across sessions | yes | per-session | yes |
| Self-hosted | yes | no | no |
| Manual GUI for operators | yes | no | yes |
| Pay per browser-hour | no | yes | varies |
| Open source core | yes | SDK only | no |

## Acceptable use

Building a multi-account browser is dual-use. We support QA testing across roles and regions, agency workflows you are authorized to run, market research, multi-marketplace e-commerce ops, AI-driven sales engineering, and personal accounts you legitimately own. We do not support platform ToS violations, mass account farming, ban evasion, or fraud. Full policy at [getmultizen.com/acceptable-use](https://getmultizen.com/acceptable-use).

## Status and history

`v0.2.x` is the current AI-native MCP rewrite (Electron + React + TS + patched Chromium engine).

The legacy `v0.1.1` codebase (Electron + Vue 2 multi-session browser, no MCP) is preserved on the [`archive/vue-v1-legacy`](https://github.com/multizenteam/multizen-browser/tree/archive/vue-v1-legacy) branch and tag [`v0.1.1-legacy-final`](https://github.com/multizenteam/multizen-browser/releases/tag/v0.1.1-legacy-final).

## License

[MIT](LICENSE). Use it however you want.

<div align="center">
  <br/>
  <sub>
    Built in transit by <a href="https://github.com/oboshto">@oboshto</a>.<br/>
    Star this repo if MultiZen is useful, it helps a lot.
  </sub>
</div>
