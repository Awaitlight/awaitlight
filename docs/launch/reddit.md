# Reddit — self-post

Best subreddits: r/ClaudeAI (primary), also fits r/LocalLLaMA. Read each sub's self-promo rules first; post from a real account with some history, and reply to comments.

---

**Title**

I kept forgetting whether my agent was still working — so I turned an old phone into an at-a-glance status display for Claude Code / Codex / Cursor

**Body**

Not affiliated with Anthropic, OpenAI, or Anysphere — it just reads the local session files those tools already write.

I have a habit of starting an agent, tabbing away, and then losing track of whether it's still working, waiting on me, or done. With three or four going at once it got bad enough that I built something to fix it, and it's been useful enough day-to-day that I figured I'd share.

It's called Awaitlight. You run `npx awaitlight` (Node 18+) — or grab the desktop client, which since v1.1.0 has the engine built in — then open the LAN address it prints on a spare phone (same Wi-Fi, landscape). The phone turns into a status screen for your agents: each one shows its state as a colored halo — running, thinking, waiting on you, or idle — plus context-window remaining, your 5-hour and weekly usage limits, model, and cost. Run several agents and they tile into a wall, so I can see the whole fleet from across the desk without alt-tabbing.

I know you can just tail the session jsonl in a pane. The thing the phone buys me is a glanceable screen I don't have to switch focus to — especially the "waiting on you" state, which is the one I kept missing.

A few things I care about:

- 100% local. Nothing leaves your machine: no account, no cloud, no telemetry.
- Zero-config. It reads the same local session files Claude Code / Codex / Cursor / Claude Cowork already write (`~/.claude` and the equivalents). No API keys.
- Zero dependencies. It's a single Node server, nothing else to install.
- English and Chinese, a handful of color themes.

The code's public on GitHub under the MIT license — properly open source, free for any use including commercial.

Repo: https://github.com/Awaitlight/awaitlight

It's built by me, a solo indie dev, so it's early and rough in places. The thing I'm least sure about is the "waiting on you" detection — whether it reliably fires across different setups and tools. If you try it, that's the part I'd most want to hear about: does it hold up for you, or does it miss?

(There's also a tiny pixel companion that wanders the screen when everything's idle. Not the point, but it makes me smile.)
