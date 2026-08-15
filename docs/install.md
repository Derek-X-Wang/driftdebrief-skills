# Installing driftdebrief-skills

DriftDebrief's agent loop has two halves:

- **EMIT** — after each turn, the agent decides whether the turn produced something durable and, if so, emits/updates/archives a debrief card.
- **SYNC** — on demand, you pull the open + drifted cards and reconcile them with the current code.

The MCP server (emit + manage tools) is shared by every harness. How EMIT is *triggered* differs per harness — Claude Code automates it with a `Stop` hook; elsewhere the agent emits from the portable `SKILL.md` guidance.

## Prerequisites (all harnesses)

1. A DriftDebrief account with access to a Workspace.
2. [Bun](https://bun.sh) installed (the CLI + MCP server run on Bun).

### Recommended: browser login

```sh
# Production (default)
bunx @driftdebrief/skills auth login

# Development
bunx @driftdebrief/skills auth login --env dev
```

The CLI opens the DriftDebrief authorization page, where you log in, choose a Workspace, and consent. It uses an ephemeral `127.0.0.1` callback plus PKCE S256, then writes the returned long-lived ingest credential to `${XDG_CONFIG_HOME:-~/.config}/driftdebrief/credentials.json` with `0600` permissions. Browser OAuth runs on `driftdebrief.derekxwang.com`; card ingestion and retrieval use the environment's separate Convex site origin automatically.

```sh
bunx @driftdebrief/skills auth status             # masked prod credential
bunx @driftdebrief/skills auth status --env dev   # masked dev credential
bunx @driftdebrief/skills auth logout             # revoke + remove prod
```

Logout authenticates `POST /api/tokens/revoke` with the saved `dd_` token. When the server supports that endpoint, it deletes the consent and cascades revocation to sibling tokens; on an older server, a 401/404, or a network failure, the CLI warns and still deletes the local entry, so revoke the token in the web UI if it may still be live.

Re-login reuses the saved public OAuth client when it is still valid, but every successful login mints a new `dd_` token. The previous token dies only after `auth logout` successfully reaches the revocation endpoint or you revoke it in the web UI.

`DRIFTDEBRIEF_ENV=dev|prod` selects the active saved credential. If it is unset, DriftDebrief defaults to **prod**. `bunx @driftdebrief/skills env` reports the effective environment and whether its credential came from `env`, `profile`, or `credentials-file`.

### Existing environment variables

Manual ingest tokens remain fully supported. Resolution order is: bare pair, selected profile pair, credentials file.

**Profile pairs + one switch** (for anyone who works against both a dev and a prod deployment):

```sh
export DRIFTDEBRIEF_API_URL_PROD="https://<prod-deployment>.convex.site"
export DRIFTDEBRIEF_TOKEN_PROD="dd_..."
export DRIFTDEBRIEF_API_URL_DEV="https://<dev-deployment>.convex.site"
export DRIFTDEBRIEF_TOKEN_DEV="dd_..."
# DRIFTDEBRIEF_ENV=dev|prod selects the pair. Unset -> prod (real cards belong
# in prod; dev data is disposable). Pin dev per-repo instead of globally, e.g.
# in that repo's .claude/settings.json:  "env": { "DRIFTDEBRIEF_ENV": "dev" }
export DRIFTDEBRIEF_AGENT="claude-code"   # or codex / cursor / a bounded slug
```

**Single environment** (no switching): just set the bare pair — it takes precedence over the profiles:

```sh
export DRIFTDEBRIEF_API_URL="https://<deployment>.convex.site"
export DRIFTDEBRIEF_TOKEN="dd_..."
```

Check what resolved at any time with **`bunx @driftdebrief/skills env`** — prints the selected environment (`dev`/`prod`/`custom`, whether it was defaulted), credential source, API URL, masked token, agent, and the auto-detected projectKey.

Card `type` on emit is **strict by default** (only the canonical `CARD_TYPES` — a typo guard at the source). To emit a type the server added but this plugin build doesn't yet vendor, opt in with `DRIFTDEBRIEF_ALLOW_UNKNOWN_TYPES=1` (or `emit --allow-unknown-type`), which accepts any bounded slug. The backend ingest boundary is tolerant regardless.

---

## Claude Code (full loop)

Claude Code gets the complete automated loop. Two pieces:

### 1. Plugin — MCP server + `/dd-sync`

```sh
claude plugin marketplace add Derek-X-Wang/driftdebrief-skills
claude plugin install driftdebrief
```

This wires the DriftDebrief MCP server (`.mcp.json`) and the `/dd-sync` slash command. (Plugin *hooks* are **not** used — see below.)

### 2. EMIT hook → `.claude/settings.json` (not the plugin)

The per-turn EMIT relies on the `Stop` hook. Plugin-defined hooks are unreliable upstream (claude-code [#16538](https://github.com/anthropics/claude-code/issues/16538), closed `NOT_PLANNED`) and `SessionStart` `additionalContext` is dropped on new sessions ([#10373](https://github.com/anthropics/claude-code/issues/10373)). So the load-bearing hook lives in `settings.json`, where it reliably fires.

Merge this into your project `.claude/settings.json` (or `~/.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bunx @driftdebrief/skills stop-hook" }] }
    ]
  }
}
```

> Cloned the repo instead of installing the published package? Run `bun src/cli.ts install` to print the snippet with the absolute path filled in, or replace the command with `bun /abs/path/to/driftdebrief-skills/src/cli.ts stop-hook`.

### 3. Use it

Work normally. After each turn the agent considers emitting a card. When you want to reconcile, run **`/dd-sync`**.

---

## Codex CLI

Codex shares the MCP server but has no Claude Code `Stop` hook, so EMIT is driven by `skills/driftdebrief/SKILL.md` (the agent emits after meaningful work) and SYNC is on demand ("sync my DriftDebrief cards").

Copy the MCP block from [`.codex-plugin/config.toml`](../.codex-plugin/config.toml) into `~/.codex/config.toml`. A prior `auth login` needs no token env block; set `DRIFTDEBRIEF_AGENT = "codex"` if you want explicit provenance. Existing env-var users can keep their current MCP env block unchanged.

---

## Cursor / Gemini CLI / other MCP harnesses

Any harness that supports MCP servers + agent instruction files can use DriftDebrief:

1. Register the MCP server: `command = bun`, `args = [<path>/src/mcp.ts]`. It reads the shared browser-login credentials automatically; an existing `DRIFTDEBRIEF_*` env block continues to take precedence.
2. Install the portable instructions so the agent knows when/how to emit (see the skills fallback below).

If the harness has a reliable post-response hook, wire it to `bunx @driftdebrief/skills stop-hook` for automated EMIT the same way Claude Code does.

---

## Portable skill fallback (any harness)

For harnesses without a plugin path, install just the instruction set:

```sh
npx skills@latest add Derek-X-Wang/driftdebrief-skills
```

This installs `skills/driftdebrief/SKILL.md`. Pair it with the MCP server registered however your harness supports it. EMIT is then agent-driven (per the SKILL); SYNC is on demand.
