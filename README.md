# driftdebrief-skills

The open-source coding-agent integration for **DriftDebrief** — emit, retrieve, and manage *debrief cards* directly from your coding agent (Claude Code, Codex, Cursor, Gemini CLI, and more).

DriftDebrief is a human–AI alignment memory tool: after an AI coding session, the agent emits lightweight **debrief cards** about what it implemented, changed, or assumed; you review them asynchronously to keep your mental model synced with project reality. This repo is the agent side of that loop.

> 🚧 **Early scaffolding.** The integration is being designed and extracted. This repo currently reserves the name and records intent; the implementation lands incrementally.

## What this will be

A single repo holding a portable core plus per-harness packaging:

- **Skills** — `SKILL.md` instructions teaching an agent *when* and *how* to emit and manage debrief cards. The portable, cross-harness unit.
- **MCP server** — the cross-agent emit / retrieve / manage tools, over DriftDebrief's HTTP API.
- **Per-harness plugin packaging** — where a harness supports it (Claude Code, Codex, Cursor, Gemini CLI), ship a plugin with a `SessionStart` hook that **guarantees** the open/`wrong` cards are injected at the start of a session, plus a `/dd-sync` command. Where it doesn't (e.g. Windsurf, Amp), the portable `SKILL.md` is the fallback.

The backend owns the canonical card vocabulary; this repo vendors a minimal copy of the contract and talks to the backend only over the HTTP API — no dependency on DriftDebrief's (closed-source) application repo.

## Install

Planned — once the first release lands:

```sh
# Plugin (guaranteed-trigger) path, per harness — e.g. Claude Code:
claude plugin install driftdebrief-skills

# Portable skill fallback (any harness via the skills CLI):
npx skills@latest add Derek-X-Wang/driftdebrief-skills
```

## License

[MIT](./LICENSE)
