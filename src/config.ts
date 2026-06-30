import { execSync } from 'node:child_process';
export interface AgentConfig {
  apiUrl: string;
  token: string;
  /** Agent identifier sent as provenance on each emitted card.
   * Defaults to 'claude-code'. Any bounded slug is accepted by the API. */
  agent: string;
  cwd: string;
}

/** Derive a stable projectKey: git remote origin, else the absolute path. */
export function resolveProjectKey(cwd: string, override?: string): string {
  if (override) return override;
  if (process.env.DRIFTDEBRIEF_PROJECT_KEY) return process.env.DRIFTDEBRIEF_PROJECT_KEY;
  try {
    const remote = execSync('git config --get remote.origin.url', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (remote) return remote;
  } catch {
    // not a git repo / no remote
  }
  return cwd;
}

/**
 * Producer-side emit is STRICT by default — `type` must be a canonical
 * CARD_TYPES value (a typo guard at the source; ADR-0007 Decision 3). Set
 * DRIFTDEBRIEF_ALLOW_UNKNOWN_TYPES=1 (or pass `emit --allow-unknown-type`) to
 * accept any bounded slug instead — the deliberate escape hatch for emitting a
 * type the server added but this plugin build does not yet vendor. The backend
 * ingest boundary is tolerant regardless.
 */
export function allowUnknownTypes(): boolean {
  return process.env.DRIFTDEBRIEF_ALLOW_UNKNOWN_TYPES === '1';
}

/** Read config from env. Throws a friendly error if required vars are missing. */
export function loadConfig(): AgentConfig {
  const apiUrl = process.env.DRIFTDEBRIEF_API_URL;
  const token = process.env.DRIFTDEBRIEF_TOKEN;
  if (!apiUrl || !token) {
    throw new Error(
      'DriftDebrief: set DRIFTDEBRIEF_API_URL (your Convex .site URL) and DRIFTDEBRIEF_TOKEN (a Workspace ingest token).',
    );
  }
  // DRIFTDEBRIEF_AGENT: any bounded slug is accepted by the API; no cast needed.
  const agent = process.env.DRIFTDEBRIEF_AGENT ?? 'claude-code';
  return { apiUrl: apiUrl.replace(/\/+$/, ''), token, agent, cwd: process.cwd() };
}
