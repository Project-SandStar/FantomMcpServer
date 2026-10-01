# Jev Browser: autonomous UI interaction for coding agents

How `jev-browser` was set up for this project, what it is good for, and how to
repeat the setup in another project. Everything below was verified on
2026-09-20 against this repository's dashboard.

## What it is

[`@jkudish/jev-browser`](https://github.com/jkudish/jev-browser) drives a real
headless Chromium from a natural-language task. Each step it asks TypeSafe's
**Jev** model (a System One model: typed judgments, no text generation) three
questions over the current page: which element to act on (a Choice over the
page's clickable, typeable and selectable elements plus scroll/back/done),
whether the goal is met, and whether the run is stuck. Code owns the loop:
step and time budgets, stop gates, recovery when an action has no effect.

You get back the final page (text, markdown, html or an aria snapshot), a
per-step trace with confidences and the goal/stuck probabilities, console and
network errors captured along the way, token usage with estimated cost, and
optionally a screenshot.

It exposes three surfaces: an MCP server (used by Claude Code here), a CLI, and
a library export `navigate()`.

Typing is the one place a second model is involved: Jev never generates text,
so a search query or a form value comes from a small LLM you configure (or
falls back to a weak keyword heuristic).

## Install in another project

Requirements: Node.js 20 or newer, a TypeSafe API key from
`https://console.typesafe.ai/settings/keys`, optionally a key for the typing
model.

1. Put the key where non-interactive shells see it (Claude Code spawns MCP
   servers without a login shell), for example in `~/.zshenv` or `~/.zshrc`:

   ```bash
   export TYPESAFE_API_KEY="ts_..."
   ```

2. Fetch the package once (this also downloads Playwright's Chromium):

   ```bash
   npx -y @jkudish/jev-browser --help
   ```

3. Register the MCP server. User scope makes it available in every project:

   ```bash
   claude mcp add -s user jev-browser -- npx -y @jkudish/jev-browser
   ```

   Some MCP clients filter the environment before spawning servers. If the
   server reports a missing key, pass it explicitly:

   ```bash
   claude mcp add -s user jev-browser -e TYPESAFE_API_KEY=ts_... -- npx -y @jkudish/jev-browser
   ```

4. Restart Claude Code. The tool appears as `mcp__jev-browser__jev_navigate`.

   If Claude Code was launched from an app (not a fresh terminal), the spawned
   server inherits the environment that app had at launch, so a key added to
   `~/.zshrc` later is not seen even after a session restart. The robust entry
   in `~/.claude.json` sources the rc file at every spawn:

   ```json
   "jev-browser": {
     "type": "stdio",
     "command": "zsh",
     "args": ["-lc", "source ~/.zshrc; exec npx -y @jkudish/jev-browser"],
     "env": {}
   }
   ```

   `"command"` must be `zsh`, not `npx`; with `npx` the server exits at once
   and Claude Code reports `Connection closed`. Verify with a task that types:
   the trace step should read `via openrouter` (or your provider), not
   `via keyword-heuristic`.

5. Give the typing model a key, or typed text will be poor. Auto-detected in
   this order: `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
   `GEMINI_API_KEY`. A local model works too:

   ```bash
   export JEV_BROWSER_TYPE_BASE_URL=http://localhost:11434/v1
   export JEV_BROWSER_TYPE_MODEL=qwen2.5:7b
   ```

   Without any of these the trace shows `via keyword-heuristic` on typed
   steps; navigation-only tasks are unaffected.

Note for Claude Code's auto permission mode: its classifier refuses to run an
unfamiliar npm package or to register an MCP server on the agent's behalf.
Steps 2 and 3 are run by the developer, typed with the `!` prefix in the
session or in a terminal.

## Using it

Tool parameters: `task` and `start_url` (required), `format`
(`text` 8k chars, `markdown` 16k, `html` 1 MB, `aria` 16k), `max_chars`,
`max_steps` (default 24), `max_seconds` (default 180), `allow_typing`
(default true), `screenshot` (`final` or `none`).

Write the task as a goal with a recognisable end state, and name the page
elements the way the UI labels them. Good: "Open the Vectors page (also
called Vector Viewer) and stop when the per-project vector table is visible."
The stop gates fire on the agent choosing `done`, goal probability above 0.85,
stuck probability above 0.85, or a budget.

Read the trace, not just the status. `done` and `goal_achieved` are two
independent judgments; agreement between them is what a trustworthy finish
looks like. A `stuck` status with repeated `no visible change` outcomes means
the page did not offer what the task needed (the login screen case below).

CLI equivalent, for scripts and CI:

```bash
npx -y @jkudish/jev-browser run "Open the Vectors page and stop on it" http://localhost:3848/dashboard/ \
  --format text --max-steps 12 --screenshot /tmp/vectors.jpg
```

## Measured runs on this dashboard

| Run | Steps | Time | Jev calls | Cost |
| --- | --- | --- | --- | --- |
| Login screen, no way in (stuck) | 4 | 5.1 s | 4 | $0.00013 |
| Signed in, Home to Vector Search to Project Vectors (done) | 4 | 4.5 s | 4 | $0.00126 |

Cost scales with page size: the signed-in dashboard sends about 30k input
tokens per run because the sidebar and project table are large.

## Limits that matter

- **Password and file inputs are never offered** to the model, and the agent
  cannot set cookies or `localStorage`. Any app with a login form stops it
  cold. See the next section for how this project handles that.
- Up to 240 interactive elements per step; denser pages are truncated and the
  state says so.
- No iframes, shadow DOM, hover-revealed menus, or keyboard-only actions.
- Next.js link prefetches show up as `request_failed HEAD ... net::ERR_ABORTED`
  in `console_events`. They are benign; do not treat them as page errors.
- Jev is calibrated, not infallible: the trace is evidence, not proof. Use
  `chrome-devtools` or `playwright` MCP when exact clicks, DevTools access, or
  the developer's signed-in Chrome are needed.

## Signing in on a dashboard with a login form

This project's dashboard stores credentials in `localStorage` after a form
login. To let a browser agent start signed in without weakening the app for
anyone else, two gates were added:

1. **Server marker file.** `src/config/devMode.ts` reports `isDevMode()` as
   true only while the file `config/dev-mode` exists on that host. The file is
   gitignored, so a fresh checkout or a public snapshot never has it. `/health`
   exposes the flag as `devMode`.

2. **Client fragment.** `dashboard/src/contexts/AuthContext.tsx` reads a URL
   fragment `#auth=<base64 of user:pass>` on load, strips it from the URL
   immediately, and honours it only when the page host is `localhost` or
   `127.0.0.1` **and** `/health` returns `devMode: true`. It then stores the
   same credentials the login form would, and the normal `/admin/users/me`
   verification still runs before anything renders. Fragments are never sent
   to the server.

Usage:

```
http://localhost:3848/dashboard/#auth=<base64 of user:pass>
```

```bash
printf '%s:%s' "$USER_NAME" "$PASS" | base64   # produce the fragment value
touch config/dev-mode                          # enable on this machine; rm it to disable
```

To port the pattern to another app: expose a server-side "dev mode" flag that
comes from a file (not an env var that could leak into a shared deployment),
and make the client honour a fragment only on localhost and only when the
server flag is on. Keep the credential verification path unchanged.

## Pairing with the rest of the toolset

- `jev-browser`: autonomous "get to X and read Y" tasks, smoke checks of a
  flow, cheap exploratory navigation, returning a page as markdown.
- `chrome-devtools` / `playwright` MCP on the developer's Chrome: precise
  interactions, console and network inspection, pages behind real sessions.
- [`@jkudish/jev-mcp`](https://github.com/jkudish/jev-mcp): the same Jev
  judgments without a browser (verify a claim against evidence, rerank,
  classify, extract fields), when the input is text you already have.
