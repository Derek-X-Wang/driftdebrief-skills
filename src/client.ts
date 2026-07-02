import type {
  ArchiveNewCardInput,
  ArchiveNewCardResponse,
  EmitInput,
  EmitResponse,
  MarkStaleInput,
  MarkStaleResponse,
  OpenCard,
  ProposeCardChangeInput,
  ProposeCardChangeResponse,
  UpdateNewCardInput,
  UpdateNewCardResponse,
} from '@driftdebrief/core';

import type { AgentConfig } from './config';

// The wire types (EmitInput, OpenCard, etc.) come from `@driftdebrief/core`
// (ADR-0009) — the same zod schemas the backend's HTTP routes validate with,
// so this client can no longer silently drift from the server's shapes.
// mcp.ts consumes OpenCard for rendering; re-export it for that one consumer.
export type { OpenCard };

function authHeaders(cfg: AgentConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' };
}

/**
 * Shared fetch helper: adds auth headers, serialises the body, and throws a
 * descriptive error on non-2xx responses. All agent API calls go through here
 * so auth and error handling are not repeated across every wrapper.
 *
 * Body is conditionally added to the RequestInit (not set for GET requests) so
 * the fetch spec is satisfied and linters don't flag an invalid GET body.
 */
async function apiFetch<T>(
  cfg: AgentConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method, headers: authHeaders(cfg) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${cfg.apiUrl}${path}`, init);
  if (!res.ok) {
    throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as T;
}

/**
 * POST /api/ingest — emit one Debrief Card. `agent` is deliberately excluded
 * from the caller-facing input: the client always injects it from
 * `AgentConfig`, even though the wire schema (`EmitInput` from
 * `@driftdebrief/core`) accepts it as an optional field.
 */
export async function emitCard(
  cfg: AgentConfig,
  input: Omit<EmitInput, 'agent'>,
): Promise<EmitResponse> {
  // Spread `input` first, then set `agent`: `input`'s static type excludes
  // `agent`, but a caller that bypasses the type could still smuggle one
  // through at runtime — putting `agent: cfg.agent` last ensures AgentConfig
  // always wins rather than being silently overridden.
  return apiFetch(cfg, 'POST', '/api/ingest', { ...input, agent: cfg.agent });
}

/** GET /api/cards/open — open / drifted cards for a project. */
export async function getOpenCards(cfg: AgentConfig, projectKey: string): Promise<OpenCard[]> {
  return apiFetch(cfg, 'GET', `/api/cards/open?projectKey=${encodeURIComponent(projectKey)}`);
}

/**
 * POST /api/mark-stale — batch-mark cards stale after the plugin detects that their
 * referenced files changed. Returns counts of how many were found and updated.
 */
export async function markStale(cfg: AgentConfig, input: MarkStaleInput): Promise<MarkStaleResponse> {
  return apiFetch(cfg, 'POST', '/api/mark-stale', input);
}

/**
 * POST /api/cards/update — update content fields on a Card that is still `new`
 * and unreviewed (ADR-0006 Decision 3). For reviewed Cards use `proposeCardChange`.
 */
export async function updateNewCard(
  cfg: AgentConfig,
  input: UpdateNewCardInput,
): Promise<UpdateNewCardResponse> {
  return apiFetch(cfg, 'POST', '/api/cards/update', input);
}

/**
 * POST /api/cards/archive — soft-archive a Card that is still `new` and unreviewed
 * (ADR-0006 Decision 3). For reviewed Cards use `proposeCardChange`.
 */
export async function archiveNewCard(
  cfg: AgentConfig,
  input: ArchiveNewCardInput,
): Promise<ArchiveNewCardResponse> {
  return apiFetch(cfg, 'POST', '/api/cards/archive', input);
}

/**
 * POST /api/cards/propose-change — surface a proposed Card change to the human
 * without mutating the Card (ADR-0006 Decision 3). Creates a `cardEvent` of type
 * `'proposal'`; the human applies the change during their next Review session.
 */
export async function proposeCardChange(
  cfg: AgentConfig,
  input: ProposeCardChangeInput,
): Promise<ProposeCardChangeResponse> {
  return apiFetch(cfg, 'POST', '/api/cards/propose-change', input);
}

/** Render open cards as a compact context block for /dd-sync. */
export function renderOpenCardsForContext(cards: OpenCard[]): string {
  if (cards.length === 0) return '';
  const lines = cards.map((c) => {
    // Use openDriftSignalCount (the live "drift still open" counter), not
    // driftSignalCount (all-time history) — once a human confirms a resync,
    // openDriftSignalCount drops to 0 even though driftSignalCount stays > 0,
    // and this flag must not keep flagging a card as active drift after that
    // (ADR-0009 Decision 4).
    const flag = c.openDriftSignalCount > 0 ? ' [DRIFT: marked wrong]' : '';
    return `- (${c.type}, ${c.importance}, ${c.state}${flag}) ${c.title}\n    ${c.body.replace(/\n/g, ' ').slice(0, 280)}`;
  });
  return [
    'DriftDebrief — unresolved debrief cards the human flagged. Use these to resync your shared mental model; treat "DRIFT: marked wrong" as a sign you and the human are out of sync on that point.',
    ...lines,
  ].join('\n');
}
