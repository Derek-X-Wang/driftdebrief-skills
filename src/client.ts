import type { AgentConfig } from './config';

export interface EmitInput {
  projectKey: string;
  /** Validated producer-side before this runs: a canonical CARD_TYPES value by
   * default (typo guard, ADR-0007 D3), or any bounded slug under the
   * DRIFTDEBRIEF_ALLOW_UNKNOWN_TYPES / --allow-unknown-type escape hatch. The
   * server's ingest boundary is tolerant regardless and renders unknowns with an
   * UNKNOWN badge. */
  type: string;
  title: string;
  body: string;
  /** Defaults to 'normal'. Unknown values are accepted by the server and stored as 'normal' with a warning. */
  importance?: string;
  sessionId?: string;
  transcriptPath?: string;
  commitSha?: string;
  files?: string[];
}

export interface OpenCard {
  id: string;
  type: string;
  title: string;
  body: string;
  importance: string;
  state: string;
  lastAction?: string | null;
  driftSignalCount: number;
  // Provenance for the plugin to diff against the working tree (mark_stale, ADR-0006 D4).
  commitSha?: string | null;
  files?: string[] | null;
}

export interface MarkStaleInput {
  cards: Array<{
    cardId: string;
    changedFiles?: string[];
    fromCommit?: string;
    toCommit?: string;
  }>;
}

export interface UpdateNewCardInput {
  cardId: string;
  patch: {
    title?: string;
    body?: string;
    /** Any bounded slug (ADR-0007 tolerant). Unknown values are stored as-is with a warning. */
    type?: string;
    /** Any string (ADR-0007 tolerant). Unknown values fall back to 'normal' with a warning. */
    importance?: string;
  };
}

export interface ArchiveNewCardInput {
  cardId: string;
  reason: string;
}

export interface ProposeCardChangeInput {
  cardId: string;
  proposal: string;
  evidence?: string;
}

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

/** POST /api/ingest — emit one Debrief Card. */
export async function emitCard(
  cfg: AgentConfig,
  input: EmitInput,
): Promise<{ id: string; projectId: string; warnings: string[] }> {
  return apiFetch(cfg, 'POST', '/api/ingest', { agent: cfg.agent, ...input });
}

/** GET /api/cards/open — open / drifted cards for a project. */
export async function getOpenCards(cfg: AgentConfig, projectKey: string): Promise<OpenCard[]> {
  return apiFetch(cfg, 'GET', `/api/cards/open?projectKey=${encodeURIComponent(projectKey)}`);
}

/**
 * POST /api/mark-stale — batch-mark cards stale after the plugin detects that their
 * referenced files changed. Returns counts of how many were found and updated.
 */
export async function markStale(
  cfg: AgentConfig,
  input: MarkStaleInput,
): Promise<{ marked: number; skipped: number }> {
  return apiFetch(cfg, 'POST', '/api/mark-stale', input);
}

/**
 * POST /api/cards/update — update content fields on a Card that is still `new`
 * and unreviewed (ADR-0006 Decision 3). For reviewed Cards use `proposeCardChange`.
 */
export async function updateNewCard(
  cfg: AgentConfig,
  input: UpdateNewCardInput,
): Promise<{ found: boolean; updated: boolean; warnings: string[] }> {
  return apiFetch(cfg, 'POST', '/api/cards/update', input);
}

/**
 * POST /api/cards/archive — soft-archive a Card that is still `new` and unreviewed
 * (ADR-0006 Decision 3). For reviewed Cards use `proposeCardChange`.
 */
export async function archiveNewCard(
  cfg: AgentConfig,
  input: ArchiveNewCardInput,
): Promise<{ found: boolean; archived: boolean; warning?: string }> {
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
): Promise<{ found: boolean; eventId?: string }> {
  return apiFetch(cfg, 'POST', '/api/cards/propose-change', input);
}

/** Render open cards as a compact context block for /dd-sync. */
export function renderOpenCardsForContext(cards: OpenCard[]): string {
  if (cards.length === 0) return '';
  const lines = cards.map((c) => {
    const flag = c.driftSignalCount > 0 ? ' [DRIFT: marked wrong]' : '';
    return `- (${c.type}, ${c.importance}, ${c.state}${flag}) ${c.title}\n    ${c.body.replace(/\n/g, ' ').slice(0, 280)}`;
  });
  return [
    'DriftDebrief — unresolved debrief cards the human flagged. Use these to resync your shared mental model; treat "DRIFT: marked wrong" as a sign you and the human are out of sync on that point.',
    ...lines,
  ].join('\n');
}
