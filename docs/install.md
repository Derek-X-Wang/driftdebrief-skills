# Installing driftdebrief-skills

DriftDebrief's agent loop has two halves:

- **EMIT** — after each turn, the agent decides whether the turn produced something durable and, if so, emits/updates/archives a debrief card.
- **SYNC** — on demand, you pull the open + drifted cards and reconcile them with the current code.

The MCP server (emit + manage tools) is shared by every harness. How EMIT is *triggered* differs per harness — Claude Code automates it with a `Stop` hook; elsewhere the agent emits from the portable `SKILL.md` guidance.

## Prerequisites (all harnesses)

1. A DriftDebrief deployment URL (`https://<deployment>.convex.site`).
2. A Workspace **ingest token** — mint one in the app under *Workspace → Ingest tokens*.
3. [Bun](https://bun.sh) installed (the CLI + MCP server run on Bun).

Set these in your environment (shell profile, or the harness's `env` block):

```sh
export DRIFTDEBRIEF_API_URL="https://<deployment>.convex.site"
export DRIFTDEBRIEF_TOKEN="dd_..."
export DRIFTDEBRIEF_AGENT="claude-code"   # or codex / cursor / a bounded slug
```

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

Copy the MCP block from [`.codex-plugin/config.toml`](../.codex-plugin/config.toml) into `~/.codex/config.toml` (set the absolute path + env).

---

## Cursor / Gemini CLI / other MCP harnesses

Any harness that supports MCP servers + agent instruction files can use DriftDebrief:

1. Register the MCP server: `command = bun`, `args = [<path>/src/mcp.ts]`, with the `DRIFTDEBRIEF_*` env.
2. Install the portable instructions so the agent knows when/how to emit (see the skills fallback below).

If the harness has a reliable post-response hook, wire it to `bunx @driftdebrief/skills stop-hook` for automated EMIT the same way Claude Code does.

---

## Portable skill fallback (any harness)

For harnesses without a plugin path, install just the instruction set:

```sh
npx skills@latest add Derek-X-Wang/driftdebrief-skills
```

This installs `skills/driftdebrief/SKILL.md`. Pair it with the MCP server registered however your harness supports it. EMIT is then agent-driven (per the SKILL); SYNC is on demand.
