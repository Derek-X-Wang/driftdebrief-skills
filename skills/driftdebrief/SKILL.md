---
name: driftdebrief
description: Use throughout a coding session to keep the human's mental model in sync — emit a debrief card when you make a durable decision, assumption, or hit a hidden constraint; retrieve and reconcile open cards when resyncing. The portable, cross-harness instruction set for the DriftDebrief MCP tools.
---

# DriftDebrief — debrief cards

DriftDebrief keeps a human and their coding agent aligned. As you work, you emit small **debrief cards** capturing durable things the human should later understand. They review the cards asynchronously; what they mark as `wrong` becomes a **drift signal** telling you the two of you are out of sync.

This skill is harness-portable. On Claude Code the EMIT step is also automated by a `Stop` hook, but the judgement below is the same everywhere.

## When to emit a card

Emit after a meaningful step — **not** for trivial Q&A, reads, or routine edits. Emit when the turn produced something the human would want to know weeks later without re-reading the diff:

- **decision** — a technical choice and *why* (and what you rejected)
- **assumption** — something you assumed because it wasn't specified
- **constraint** — a hidden gotcha, dependency, or limitation you discovered
- **change** — a direction shift from what was previously agreed
- **implementation** — a non-obvious thing you built and how it works
- **watch_out** — something likely to be misunderstood or to bite later

Bias to **few, high-signal cards** — one or two per meaningful turn at most, never a changelog of every edit. A card the human will skim past is noise.

## How to emit and manage (MCP tools)

- `driftdebrief_emit_card` — emit a new card: `type`, `title` (scannable headline), `body` (markdown), optional `importance` (`low|normal|high`), `files`, `commitSha`.
- `driftdebrief_get_open_cards` — fetch unresolved + drifted cards for this project. Lead with any flagged `[DRIFT: marked wrong]` — resolve those first.
- `driftdebrief_mark_stale` — after detecting the files a card describes have changed (`git diff --name-only <commitSha>..HEAD -- <files>`), mark it stale so the human re-reviews. Does not resolve the card.

### State-scoped editing (important)

A card the human has **not yet reviewed** (`new`) is yours to refine:

- `driftdebrief_update_new_card` — fix the title/body/type/importance of a card you just emitted.
- `driftdebrief_archive_new_card` — soft-retract a `new` card that turned out wrong or duplicate (history is preserved; no hard delete).

A card the human has **already reviewed** is theirs — never mutate it directly:

- `driftdebrief_propose_card_change` — surface a proposed change as an append-only event; the human applies it during their next Review.

The server enforces this boundary, but respect it in intent: don't try to update/archive a reviewed card.

## Input validation

**`type` is strict by default** — emit one of the canonical `CARD_TYPES` above. This is a typo guard at the source (LLMs fat-finger type strings): an off-list value is rejected so you retry with a real one. To emit a type the server added but this plugin build doesn't yet vendor, opt in deliberately with `DRIFTDEBRIEF_ALLOW_UNKNOWN_TYPES=1` (or `emit --allow-unknown-type`), which accepts any bounded slug.

`importance` is tolerant — unknown values fall back to `normal` with a soft warning.

The **server's** ingest boundary is tolerant regardless (stores raw, renders unknowns with an UNKNOWN badge); the strictness above is only the producer-side guard. The backend owns the canonical vocabulary (ADR-0007).

## Syncing

When the human (or you) want to reconcile: call `driftdebrief_get_open_cards`, surface drift-flagged cards first, mark stale anything whose code moved, and propose/apply changes per the state rules above. On Claude Code this is the `/dd-sync` command.
