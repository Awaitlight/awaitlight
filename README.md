# Awaitlight

**English** | [简体中文](README.zh-CN.md)

**Turn any spare phone into a live status display for your AI coding agents.**

![Awaitlight — a glowing status halo showing an agent executing, with model, context window and usage limits](docs/hero.png)

One glance tells you whether each agent is **running**, **thinking**, **waiting on you**, or **idle** — plus remaining **context window** and your **usage limits** — without alt-tabbing into a terminal. 100% local: it reads the session files your tools already write on your machine; nothing leaves your network.

![The Awaitlight status halo animating in the thinking state](docs/halo.gif)

## Quick start

Pick one of three ways to get the server running on your computer:

### 1. Desktop client (easiest)

Download the client for macOS / Windows from [awaitlight.com/download](https://awaitlight.com/download) or from [GitHub Releases (`client-v1.1.0`)](https://github.com/Awaitlight/awaitlight/releases/tag/client-v1.1.0).

Since **v1.1.0** the engine is **built into the client** — install it, open it, and you're looking at real data immediately. No Node, no terminal.

### 2. One command (Node 18+)

```bash
npx awaitlight
```

> The npm package is landing this week — if the command isn't live yet, use option 1 or 3.

### 3. From source

```bash
git clone https://github.com/Awaitlight/awaitlight.git
cd awaitlight
node server.js
```

To use a different port with either of the last two: `PORT=8799 npx awaitlight`.

### Then: the phone (3 steps)

The server prints a LAN address (something like `http://192.168.x.x:8787`).

1. On a spare phone **on the same Wi-Fi**, open that address in the browser.
2. Turn the phone **landscape** and prop it up next to your keyboard.
3. **Save it as a bookmark** — do **not** use "Add to Home Screen". A bookmark opens in the normal browser, which keeps the live connection and screen-wake behavior working the way Awaitlight expects.

A control panel for themes, language, and the idle companion is at the printed `…/control` address (open it on your computer).

## Works with

| Tool | What you get | Platforms |
| --- | --- | --- |
| **Claude Code** | Full: state (running / thinking / waiting-on-you / idle), context window, 5-hour & weekly usage limits, model, cost | macOS / Linux / Windows |
| **Claude Cowork** | Session state and activity | **macOS only** (reads Cowork's local session files, which live in a macOS-specific location) |
| **Codex CLI** | Session state and activity (from local session logs) | macOS / Linux / Windows |
| **Cursor** | Session activity (from Cursor's local state database) | **macOS only**, and requires a Node build with `node:sqlite` (Node 22.5+); silently off otherwise |

Claude Code is the most complete integration; the others are read-only best-effort parsers of each tool's local files, so a format change upstream can break them until we catch up.

> Awaitlight is an independent project that works with Claude Code, Codex, and Cursor. It is **not affiliated with, endorsed by, or sponsored by** Anthropic, OpenAI, or Anysphere. These names are used only to describe interoperability.

## Features

- **At-a-glance state** — running / thinking / waiting-on-you / idle, shown as a status halo.
- **Context & limits** — remaining context window and progress toward your usage limits.
- **Multi-agent wall** — several active agents tile into a monitoring grid.
- **Idle companion** — an original pixel creature plays on screen when nothing is running.
- **Stays awake** — keeps the phone screen on while it's acting as a display.
- **Local only** — reads agent activity on your own machine; no account, no cloud, no telemetry.
- **Zero npm dependencies** — one Node server built on `node:http` and `node:fs`; nothing to audit.
- **Themes & language** — a handful of color themes, English and Chinese (set from `…/control`).

### Custom companion

You can replace the built-in idle creature with your own art by defining `window.AWAITLIGHT_PET` on the page — see [`pets/README.md`](pets/README.md). Bring your own sprite; you are responsible for the rights to whatever art you use. Awaitlight ships only its own original creature.

## FAQ

**Does anything leave my machine?**
No. The server reads local session files and serves a page to your phone over your own Wi-Fi. No account, no cloud, no telemetry.

**Is it safe on shared networks?**
The server binds on your LAN with **no auth** — anyone on the same network can open the page and see project names, model, and cost. Treat it as a trusted-home-network tool, not something for coffee-shop Wi-Fi.

**How does state detection work?**
Heuristic parsing of the local session logs each tool writes (e.g. the JSONL under `~/.claude/projects/`). It can lag or misread, and it breaks when a tool changes its format until we catch up. Bug reports welcome.

**The phone screen dims / disconnects.**
Make sure you opened the page in the normal browser via a **bookmark**, not "Add to Home Screen" — the home-screen wrapper breaks the wake-lock and live-connection behavior.

**Different port?**
`PORT=8799 npx awaitlight` (or the same env var with `node server.js`).

## Hardware

An ambient **hardware status light** is **coming soon** — join the waitlist at [awaitlight.com](https://awaitlight.com).

## License

MIT — fully open source, free for any use including commercial. See [`LICENSE`](LICENSE).

Third-party components and trademark notices are listed in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
