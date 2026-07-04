# Show HN

Submit at https://news.ycombinator.com/submit — **title** goes in the title field, **body** in the text field.
Post it yourself (real account). Best timing: a weekday, ~8–10am US Pacific. Then stay in the thread and reply to comments for the first few hours.

---

**Title**

Show HN: Awaitlight – Turn a spare phone into a status display for AI coding agents (Claude Code, Codex, Cursor)

**Body**

I built a tool that turns an old phone into a status display for AI coding agents like Claude Code, Codex, and Cursor.

The problem it solves for me: I kick off an agent, switch windows, and forget about it. Then I tab back twenty minutes later to find it stalled on a permission prompt, or done and waiting, or burning through context. I wanted to glance at something on my desk and just know.

How it works: you run the desktop client (since v1.1.0 the engine is built in — install and you're looking at real data), or `npx awaitlight` if you'd rather stay in the terminal (Node 18+). Either way a small local server starts and prints a LAN address. You open that on a spare phone on the same Wi-Fi, in landscape, and prop it up. The phone shows a glowing "halo" whose color reflects the agent's state (running / thinking / waiting on you / idle), plus context-window remaining, Claude plan usage limits (the 5-hour and weekly windows), model, and cost. If you run several agents, they tile into a wall. The page holds a Wake Lock so the phone doesn't dim. When everything's idle, a small pixel companion plays on screen — that part's just for fun.

How state detection works (the part I most want feedback on): the tools write local session logs — for Claude Code these are the JSONL files under ~/.claude/projects/, and the other tools have their own local session/log files. The server watches those files and reads the tail to infer state from the most recent events: an unanswered tool-permission request reads as "waiting on you," a recent assistant/tool event as "running," a stretch of no new events as "idle." Usage and cost come from the same logs. So it's heuristic and it can lag or misread, and when a tool changes its log format it breaks until I catch up.

On the server itself: it's one ~790-line file. No Express, no bundler, no client framework — just Node's built-in http and fs, which is why there's no npm install tree to audit. Needs a recent Node (18+). English and Chinese.

A note on security: the server binds on your LAN with no auth, so anyone on the same network can open the page and see your project names, model, and cost. Treat it as a trusted-home-network tool, not something to run on coffee-shop Wi-Fi.

Honest about the limits:
- It's early, and it's a solo side project.
- State detection is heuristic parsing of local files, so it can lag or misread, and a tool's format change can break it until I catch up.
- No auth on the LAN server (see above).
- There's a packaged desktop client now (v1.1.0, engine built in), but the npx/source path is still just "run a Node script you can read in one sitting".
- The phone has to be on the same network as your machine; it's a LAN dashboard, not a hosted service.
- It's an independent project. Not affiliated with or endorsed by Anthropic, OpenAI, or Anysphere — I just read the files their tools write locally.

On licensing: it's MIT — properly open source, free for any use, commercial included. Do whatever you want with it.

Repo: https://github.com/Awaitlight/awaitlight

Two things I'd genuinely like input on: does the state-detection approach above seem sound, or is there a more reliable signal I'm missing? And which agents/tools would you want supported next?
