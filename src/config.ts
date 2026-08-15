import { execSync } from 'node:child_process';

import {
  ENVIRONMENT_BASE_URLS,
  getCredentialsPath,
  readCredentialsFile,
} from './credentials';

export interface AgentConfig {
  apiUrl: string;
  token: string;
  /** Agent identifier sent as provenance on each emitted card.
   * Defaults to 'claude-code'. Any bounded slug is accepted by the API. */
  agent: string;
  cwd: string;
}

/**
 * How the active environment was chosen:
 * - `custom` — bare DRIFTDEBRIEF_API_URL/TOKEN set (highest precedence, the
 *   original single-env style; both must be present).
 * - `dev` / `prod` — selected from the profile pairs
 *   (DRIFTDEBRIEF_API_URL_DEV/_PROD + DRIFTDEBRIEF_TOKEN_DEV/_PROD) via
 *   DRIFTDEBRIEF_ENV; `defaulted` is true when DRIFTDEBRIEF_ENV was unset and
 *   prod was chosen implicitly.
 * - `source` identifies the winning tier: bare env, profile pair, or saved
 *   browser-login credentials.
 */
export interface EnvResolution {
  selected: 'dev' | 'prod' | 'custom';
  defaulted: boolean;
  source: 'env' | 'profile' | 'credentials-file';
  apiUrl?: string;
  token?: string;
  credentialsPath?: string;
  /** Set when resolution failed; names the exact variables to fix. */
  error?: string;
}

/**
 * Resolve which environment (and credentials) the plugin talks to.
 *
 * Precedence (decided via Codex counsel, 2026-07-05):
 * 1. Bare `DRIFTDEBRIEF_API_URL` + `DRIFTDEBRIEF_TOKEN` → `custom`. Setting
 *    only one of the two is an error, not a half-profile mix.
 * 2. `DRIFTDEBRIEF_ENV=dev|prod` → the matching `_DEV`/`_PROD` pair.
 * 3. When the selected pair is entirely absent, use the matching entry from
 *    `~/.config/driftdebrief/credentials.json`.
 *
 * With no explicit environment, **default `prod`** (`defaulted: true`). Emit is non-destructive
 *    and real dogfood cards belong in prod; dev is disposable, so silently
 *    routing there is the worse failure. Pin dev explicitly per repo (e.g.
 *    `.claude/settings.json` → `"env": { "DRIFTDEBRIEF_ENV": "dev" }`).
 *
 * Never throws — callers that need hard config (loadConfig) throw on
 * `resolution.error`; the `driftdebrief env` diagnostic prints it instead.
 */
export function resolveEnv(
  env: NodeJS.ProcessEnv = process.env,
  credentialsPath = getCredentialsPath(env),
): EnvResolution {
  const bareUrl = env.DRIFTDEBRIEF_API_URL;
  const bareToken = env.DRIFTDEBRIEF_TOKEN;
  if (bareUrl || bareToken) {
    if (!bareUrl || !bareToken) {
      return {
        selected: 'custom',
        defaulted: false,
        source: 'env',
        apiUrl: bareUrl,
        token: bareToken,
        error:
          'DRIFTDEBRIEF_API_URL and DRIFTDEBRIEF_TOKEN must be set together (or use the DRIFTDEBRIEF_ENV profile pairs instead).',
      };
    }
    return {
      selected: 'custom',
      defaulted: false,
      source: 'env',
      apiUrl: bareUrl,
      token: bareToken,
    };
  }

  const raw = env.DRIFTDEBRIEF_ENV;
  if (raw !== undefined && raw !== 'dev' && raw !== 'prod') {
    return {
      selected: 'prod',
      defaulted: false,
      source: 'profile',
      error: `DRIFTDEBRIEF_ENV="${raw}" is not valid — use "dev" or "prod".`,
    };
  }
  const selected: 'dev' | 'prod' = raw ?? 'prod';
  const defaulted = raw === undefined;

  const suffix = selected === 'dev' ? '_DEV' : '_PROD';
  const apiUrl = env[`DRIFTDEBRIEF_API_URL${suffix}`];
  const token = env[`DRIFTDEBRIEF_TOKEN${suffix}`];
  if (apiUrl !== undefined || token !== undefined) {
    if (apiUrl && token) {
      return { selected, defaulted, source: 'profile', apiUrl, token };
    }
    const missing = [
      !apiUrl ? `DRIFTDEBRIEF_API_URL${suffix}` : null,
      !token ? `DRIFTDEBRIEF_TOKEN${suffix}` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    return {
      selected,
      defaulted,
      source: 'profile',
      apiUrl,
      token,
      error: `DriftDebrief (${selected}${defaulted ? ', defaulted' : ''}): set ${missing} — or set DRIFTDEBRIEF_API_URL + DRIFTDEBRIEF_TOKEN directly for a single environment.`,
    };
  }

  const baseUrl = ENVIRONMENT_BASE_URLS[selected];
  const credential = readCredentialsFile(credentialsPath).credentials[baseUrl];
  if (credential) {
    return {
      selected,
      defaulted,
      source: 'credentials-file',
      apiUrl: baseUrl,
      token: credential.dd_ingest_token,
      credentialsPath,
    };
  }

  return {
    selected,
    defaulted,
    source: 'credentials-file',
    credentialsPath,
    error: `DriftDebrief (${selected}${defaulted ? ', defaulted' : ''}): run "driftdebrief auth login${selected === 'dev' ? ' --env dev' : ''}" or set DRIFTDEBRIEF_API_URL${suffix} + DRIFTDEBRIEF_TOKEN${suffix}.`,
  };
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
  const resolution = resolveEnv();
  if (resolution.error || !resolution.apiUrl || !resolution.token) {
    throw new Error(
      resolution.error ??
        'DriftDebrief: run "driftdebrief auth login", set DRIFTDEBRIEF_API_URL + DRIFTDEBRIEF_TOKEN, or configure the DRIFTDEBRIEF_ENV profile pairs.',
    );
  }
  // DRIFTDEBRIEF_AGENT: any bounded slug is accepted by the API; no cast needed.
  const agent = process.env.DRIFTDEBRIEF_AGENT ?? 'claude-code';
  return {
    apiUrl: resolution.apiUrl.replace(/\/+$/, ''),
    token: resolution.token,
    agent,
    cwd: process.cwd(),
  };
}
