---
description: Pull open + drifted DriftDebrief cards for this repo and reconcile them with the current state of the code.
---

Sync this session's shared mental model with the human via DriftDebrief.

1. Call the `driftdebrief_get_open_cards` MCP tool for the current project.
2. Present the returned cards grouped by state, **leading with any card flagged `[DRIFT: marked wrong]`** — those are points where you and the human are out of sync and must be resolved first.
3. For each card, briefly say whether it still matches the current code:
   - If the card describes something that has since changed, call `driftdebrief_mark_stale` for it (run `git diff --name-only <card.commitSha>..HEAD -- <card.files>` to confirm the area actually changed).
   - If a card you previously emitted (still `new`/unreviewed) is now wrong or redundant, fix it with `driftdebrief_update_new_card` or retract it with `driftdebrief_archive_new_card`.
   - If a card the human has **already reviewed** needs a change, do NOT edit it — call `driftdebrief_propose_card_change` so the human applies it during their next Review.
4. End with a one-line summary: how many cards are open, how many drifted, and what (if anything) you reconciled.

If there are no open cards, say so and stop.
