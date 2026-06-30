/**
 * DriftDebrief ingest contract — VENDORED copy of the emit-side vocabulary.
 *
 * This is a deliberate, standalone vendor of the public ingest contract so this
 * repo has NO dependency on the closed-source DriftDebrief application repo
 * (ADR-0006 Decision 2). The canonical source of truth is that repo's
 * `packages/types/src/index.ts`; only the agent-emitter-relevant subset is
 * copied here. The two stay in sync through the HTTP wire contract, which is
 * additive-only and tolerant (ADR-0007): the server accepts unknown bounded
 * slugs and stores them, so a drift between this copy and the server is safe.
 */

/** What kind of understanding a Card carries. */
export const CARD_TYPES = [
  'implementation', // what was built
  'change', // what changed / direction shift
  'assumption', // what the agent assumed
  'decision', // a technical choice + why
  'constraint', // a hidden constraint or gotcha
  'watch_out', // a heads-up / likely future misunderstanding
] as const;
export type CardType = (typeof CARD_TYPES)[number];

export function isCardType(value: unknown): value is CardType {
  return typeof value === 'string' && (CARD_TYPES as readonly string[]).includes(value);
}

/**
 * Bounded slug grammar for the public ingest boundary (ADR-0007).
 * `^[a-z][a-z0-9_]*$` — lowercase-only, starts with a letter, underscores ok.
 * Tolerant ≠ any-string: this rejects spaces, uppercase, leading digits, etc.
 * The server accepts any value matching this even if it is not in CARD_TYPES.
 */
export const CARD_TYPE_SLUG_RE = /^[a-z][a-z0-9_]*$/;

/** Maximum length for a public-ingest card type slug (ADR-0007). */
export const CARD_TYPE_MAX_LEN = 40;

/** True if `raw` satisfies the public-ingest bounded slug grammar (≤40, slug). */
export function isValidCardTypeSlug(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length <= CARD_TYPE_MAX_LEN && CARD_TYPE_SLUG_RE.test(raw);
}

/** Importance drives the priority score and importance-gated resurfacing. */
export const IMPORTANCE_LEVELS = ['low', 'normal', 'high'] as const;
export type Importance = (typeof IMPORTANCE_LEVELS)[number];

/**
 * Normalize a raw `importance` value from the public ingest boundary. Unknown
 * values fall back to `'normal'`; `undefined` is treated as the default.
 */
export function normalizeImportance(raw: string | undefined): { value: Importance; known: boolean } {
  if (raw === undefined) return { value: 'normal', known: true };
  if ((IMPORTANCE_LEVELS as readonly string[]).includes(raw)) {
    return { value: raw as Importance, known: true };
  }
  return { value: 'normal', known: false };
}

/** Where a Card came from (provenance). Any bounded slug is accepted by the API. */
export const AGENT_SOURCES = ['claude-code', 'codex', 'cursor', 'manual'] as const;
export type AgentSource = (typeof AGENT_SOURCES)[number];

/** Bounded slug grammar for open-provenance agent identifiers (ADR-0007). */
export const AGENT_SOURCE_SLUG_RE = /^[a-z][a-z0-9_-]*$/;

/** Maximum length for an agent provenance identifier. */
export const AGENT_SOURCE_MAX_LEN = 50;
