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

# 2. EMIT hook -> .claude/settings.json (NOT the plugin — plugin hooks are broken upstream)
#    Merge the Stop block from hooks/stop-hook.settings.json, or run:
bunx driftdebrief install   # prints the exact snippet + commands
```

The CLI + MCP server are on npm as [`driftdebrief`](https://www.npmjs.com/package/driftdebrief) — `bunx driftdebrief <cmd>` works anywhere Bun is installed (from a clone, substitute `bun src/cli.ts`).

Then set `DRIFTDEBRIEF_API_URL` + `DRIFTDEBRIEF_TOKEN` (mint a token in the app: *Workspace → Ingest tokens*), work normally, and run **`/dd-sync`** when you want to reconcile.

Full per-harness instructions (Codex, Cursor, Gemini, the portable `npx skills` fallback): **[`docs/install.md`](docs/install.md)**.

## What's in here

```
driftdebrief-skills/
├── src/                          # MCP server + CLI + vendored ingest contract
│   ├── mcp.ts                    # the DriftDebrief MCP server (6 card tools)
│   ├── cli.ts                    # driftdebrief CLI (mcp | stop-hook | open | emit | ...)
│   ├── reflect.ts                # the Stop-hook EMIT driver (block+reason, loop-guarded)
│   ├── client.ts / config.ts     # HTTP client + env config
│   └── contract.ts               # VENDORED card vocabulary (no dep on the closed app repo)
├── skills/driftdebrief/SKILL.md  # portable: when + how to emit / manage cards
├── commands/dd-sync.md           # /dd-sync slash command
├── hooks/stop-hook.settings.json # copy-paste Stop hook for YOUR settings.json
├── .mcp.json                     # MCP server config (Claude Code auto-loads)
├── .claude-plugin/               # plugin.json + marketplace.json
├── .codex-plugin/config.toml     # Codex MCP config
├── skills.sh.json                # npx skills add manifest
└── docs/install.md               # per-harness install
```

The backend owns the canonical card vocabulary; this repo **vendors** a minimal copy of the ingest contract (`src/contract.ts`) and talks to the backend only over its HTTP API — **no dependency on DriftDebrief's (closed-source) application repo**. The wire contract is additive-only and tolerant, so the two staying loosely in sync is safe.

## Development

```sh
bun install
bun run check-types     # tsc --noEmit
bun src/mcp.ts          # run the MCP server (needs DRIFTDEBRIEF_* env)
```

## License

[MIT](./LICENSE)
