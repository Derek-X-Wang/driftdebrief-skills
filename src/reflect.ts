/**
 * The DriftDebrief `Stop` hook — the EMIT half of the loop.
 *
 * Claude Code fires the `Stop` hook when the agent finishes responding to a
 * user turn. This command reads the hook payload on stdin and, on the first
 * Stop of a turn, returns `{ decision: "block", reason }`. That makes Claude
 * continue for one more turn and act on the reason: decide whether the turn
 * produced anything card-worthy and, if so, call the DriftDebrief MCP tools.
 *
 * Why `Stop` and not `SessionStart`: plugin-defined hooks are unreliable
 * (claude-code #16538, closed NOT_PLANNED) and `SessionStart` additionalContext
 * is dropped on new interactive sessions (#10373, open). `Stop` reliably
 * executes and its `decision`/`reason` reliably reaches the model. Install this
 * in `.claude/settings.json` (NOT a plugin) so it actually fires.
 *
 * Loop safety: Claude sets `stop_hook_active: true` on the continuation turn it
 * spawns. We MUST allow the stop in that case, or we loop forever (Claude also
 * force-ends after 8 consecutive blocks / CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, but
 * we should not rely on that backstop).
 */

export const REFLECT_REASON = [
  'DriftDebrief checkpoint — review the turn you just finished. If it produced something durable the human should later understand, record it with the DriftDebrief MCP tools:',
  '- a NEW insight (a decision + why, an assumption you made, a hidden constraint or gotcha, a direction change, or something likely to be misunderstood later) → driftdebrief_emit_card',
  '- a refinement to a card you emitted earlier this session that is still unreviewed → driftdebrief_update_new_card',
  '- a card you emitted that turned out wrong or duplicate and is still unreviewed → driftdebrief_archive_new_card',
  '- a change to a card the human has ALREADY reviewed → driftdebrief_propose_card_change (never edit a reviewed card directly)',
  'Emit only what is genuinely worth the human\'s attention — one or two cards at most, not a log of everything. If nothing this turn is card-worthy (a trivial question, reads, or no durable decision), record nothing and finish. Do not announce this checkpoint to the user.',
].join('\n');

interface StopHookPayload {
  stop_hook_active?: boolean;
  hook_event_name?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * Run the Stop hook: emit a one-shot block+reason on the first Stop of a turn,
 * and allow the stop on the continuation turn (or whenever we can't parse the
 * payload — fail open so we never trap the agent in a loop).
 */
export async function runStopHook(): Promise<void> {
  let payload: StopHookPayload;
  try {
    const raw = await readStdin();
    // Empty / unreadable / non-JSON payload: fail open (allow stop), never loop.
    // Real Claude Code always sends a JSON payload with stop_hook_active.
    if (!raw) return;
    payload = JSON.parse(raw) as StopHookPayload;
  } catch {
    return;
  }

  // Continuation turn we spawned: let it stop. This is the loop guard.
  if (payload.stop_hook_active) return;

  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: REFLECT_REASON,
    }),
  );
}
