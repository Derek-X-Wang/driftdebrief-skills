import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export type DriftEnvironment = 'dev' | 'prod';

/** Browser OAuth and DCR live on the web application origins. */
export const OAUTH_BASE_URLS: Record<DriftEnvironment, string> = {
  dev: 'https://dev.driftdebrief.derekxwang.com',
  prod: 'https://driftdebrief.derekxwang.com',
};

/** Card ingestion and retrieval live directly on the Convex site origins. */
export const API_BASE_URLS: Record<DriftEnvironment, string> = {
  dev: 'https://proficient-fish-674.convex.site',
  prod: 'https://dynamic-antelope-631.convex.site',
};

export interface StoredCredential {
  apiUrl: string;
  dd_ingest_token: string;
  client_id: string;
  workspace?: unknown;
  created_at: string;
}

export interface CredentialsFile {
  version: 1;
  credentials: Record<string, StoredCredential>;
}

function emptyCredentialsFile(): CredentialsFile {
  return { version: 1, credentials: {} };
}

/** The single credentials file shared by the CLI, MCP server, and hooks. */
export function getCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(configHome, 'driftdebrief', 'credentials.json');
}

/**
 * Missing, malformed, and schema-incompatible files behave like an empty
 * store. Read/permission errors are rethrown so `auth login` never clobbers a
 * credentials file that merely could not be read.
 */
export function readCredentialsFile(path = getCredentialsPath()): CredentialsFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCredentialsFile();
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyCredentialsFile();
    const candidate = parsed as Partial<CredentialsFile>;
    if (candidate.version !== 1 || !candidate.credentials || typeof candidate.credentials !== 'object') {
      return emptyCredentialsFile();
    }

    const credentials: Record<string, StoredCredential> = {};
    for (const [baseUrl, value] of Object.entries(candidate.credentials)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Partial<StoredCredential>;
      if (!entry.dd_ingest_token || !entry.client_id || !entry.created_at) continue;

      const environment = (Object.entries(OAUTH_BASE_URLS) as [DriftEnvironment, string][]).find(
        ([, oauthBaseUrl]) => oauthBaseUrl === baseUrl,
      )?.[0];
      const apiUrl = environment ? API_BASE_URLS[environment] : entry.apiUrl;
      if (!apiUrl) continue;

      credentials[baseUrl] = {
        apiUrl,
        dd_ingest_token: entry.dd_ingest_token,
        client_id: entry.client_id,
        created_at: entry.created_at,
        ...(entry.workspace === undefined ? {} : { workspace: entry.workspace }),
      };
    }
    return { version: 1, credentials };
  } catch {
    return emptyCredentialsFile();
  }
}

/** Atomically write credentials and enforce owner-only permissions. */
export function writeCredentialsFile(store: CredentialsFile, path = getCredentialsPath()): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not exist yet; preserve the original error.
    }
    throw error;
  }
}

export function credentialForEnvironment(
  environment: DriftEnvironment,
  path = getCredentialsPath(),
): StoredCredential | undefined {
  return readCredentialsFile(path).credentials[OAUTH_BASE_URLS[environment]];
}

export function maskToken(token?: string): string {
  if (!token) return '(not set)';
  if (token.length <= 8) return `${token.slice(0, 2)}… (${token.length} chars)`;
  return `${token.slice(0, 3)}…${token.slice(-4)} (${token.length} chars)`;
}
