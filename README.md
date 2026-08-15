# driftdebrief-skills

The open-source coding-agent integration for **DriftDebrief** — emit, retrieve, and manage *debrief cards* directly from your coding agent (Claude Code, Codex, Cursor, and more).

DriftDebrief is a human–AI alignment memory tool. As an AI agent works, it emits lightweight **debrief cards** about what it decided, changed, or assumed; you review them asynchronously to keep your mental model synced with project reality. What you mark `wrong` becomes a **drift signal** that tells the agent you're out of sync. This repo is the agent side of that loop.

## The loop

| Half | What happens | Trigger |
|---|---|---|
| **EMIT** | After a meaningful turn, the agent decides whether it produced something durable and emits / updates / archives a card. | Claude Code: a `Stop` hook fires after every turn. Other harnesses: the agent emits from the `SKILL.md` guidance. |
| **SYNC** | You pull the open + drifted cards and reconcile them with the current code. | On demand — `/dd-sync` on Claude Code, or just ask the agent. |

There is deliberately **no `SessionStart` auto-inject**: its `additionalContext` is dropped on new sessions (claude-code [#10373](https://github.com/anthropics/claude-code/issues/10373)), and plugin-defined hooks are unreliable ([#16538](https://github.com/anthropics/claude-code/issues/16538), closed `NOT_PLANNED`). EMIT rides the reliable `Stop` hook; SYNC is explicit. See [`docs/install.md`](docs/install.md) for why.

## Quick start (Claude Code)

```sh
# 1. Plugin: MCP server (emit/manage tools) + /dd-sync
claude plugin marketplace add Derek-X-Wang/driftdebrief-skills
claude plugin install driftdebrief

# 2. Sign in through the browser (prod by default; add --env dev for dev)
bunx @driftdebrief/skills auth login

# 3. EMIT hook -> .claude/settings.json (NOT the plugin — plugin hooks are broken upstream)
#    Merge the Stop block from hooks/stop-hook.settings.json, or run:
bunx @driftdebrief/skills install   # prints the exact snippet + commands
```

The CLI + MCP server are on npm as [`@driftdebrief/skills`](https://www.npmjs.com/package/@driftdebrief/skills) — `bunx @driftdebrief/skills <cmd>` works anywhere Bun is installed (from a clone, substitute `bun src/cli.ts`).

`auth login` uses browser OAuth with PKCE, lets you choose a Workspace and consent, then saves the resulting ingest credential in `${XDG_CONFIG_HOME:-~/.config}/driftdebrief/credentials.json` with `0600` permissions. If that file is malformed, the CLI preserves it beside the active file as `credentials.json.corrupt-<timestamp>`, warns with the exact path, and keeps only the three most recent backups because they may contain live tokens. Use `auth status` to inspect the saved credential and the effective winning config tier.

`auth logout` self-revocation requires a server with `/api/tokens/revoke` support; on older servers the CLI warns, removes the local entry, and tells you to revoke in the web UI. Re-login reuses the saved public OAuth client when possible, but it mints a new `dd_` token; if the browser shows an OAuth client error and the CLI times out, rerun `auth login --fresh-client` to force a new public-client registration. The prior token remains live until logout successfully reaches a self-revocation-capable server or you revoke it in the web UI.

Existing environment configuration remains supported with unchanged precedence: the bare `DRIFTDEBRIEF_API_URL` + `DRIFTDEBRIEF_TOKEN` pair wins first, then the selected `_DEV`/`_PROD` profile pair, then the credentials file. Verify the effective environment and source with `bunx @driftdebrief/skills env`. Work normally, then run **`/dd-sync`** to reconcile.

Full per-harness instructions (Codex, Cursor, Gemini, the portable `npx skills` fallback): **[`docs/install.md`](docs/install.md)**.

## What's in here

```
driftdebrief-skills/
├── src/                          # MCP server + CLI
│   ├── mcp.ts                    # the DriftDebrief MCP server (6 card tools)
│   ├── cli.ts                    # driftdebrief CLI (mcp | stop-hook | open | emit | ...)
│   ├── reflect.ts                # the Stop-hook EMIT driver (block+reason, loop-guarded)
│   └── client.ts / config.ts     # HTTP client (types from @driftdebrief/core) + env config
├── skills/driftdebrief/SKILL.md  # portable: when + how to emit / manage cards
├── commands/dd-sync.md           # /dd-sync slash command
├── hooks/stop-hook.settings.json # copy-paste Stop hook for YOUR settings.json
├── .mcp.json                     # MCP server config (Claude Code auto-loads)
├── .claude-plugin/               # plugin.json + marketplace.json
├── .codex-plugin/config.toml     # Codex MCP config
├── skills.sh.json                # npx skills add manifest
└── docs/install.md               # per-harness install
```

The backend owns the canonical card vocabulary and publishes it (plus the zod wire schemas its HTTP routes validate with) as [`@driftdebrief/core`](https://www.npmjs.com/package/@driftdebrief/core), which this repo pins as a normal dependency — the client literally cannot drift from the server's shapes. There is still **no dependency on DriftDebrief's (closed-source) application repo itself**; the wire contract stays additive-only and tolerant, and CI diffs our pinned core against the live `GET /api/contract` so deployed-vs-published skew is loud.

## Development

```sh
bun install
bun run check-types     # tsc --noEmit
bun src/mcp.ts          # run the MCP server (uses auth login or DRIFTDEBRIEF_* env)
```

## License

[MIT](./LICENSE)
