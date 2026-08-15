import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  created_at: string;
}

export interface CredentialsFile {
  version: 1;
  credentials: Record<string, StoredCredential>;
}

interface CredentialsReadResult {
  store: CredentialsFile;
  corrupted: boolean;
}

function emptyCredentialsFile(): CredentialsFile {
  return { version: 1, credentials: {} };
}

/** The single credentials file shared by the CLI, MCP server, and hooks. */
export function getCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(configHome, 'driftdebrief', 'credentials.json');
}

function readCredentialsFileResult(path: string): CredentialsReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { store: emptyCredentialsFile(), corrupted: false };
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { store: emptyCredentialsFile(), corrupted: true };
    }
    const candidate = parsed as Partial<CredentialsFile>;
    if (candidate.version !== 1 || !candidate.credentials || typeof candidate.credentials !== 'object') {
      return { store: emptyCredentialsFile(), corrupted: true };
    }

    const credentials: Record<string, StoredCredential> = {};
    let corrupted = false;
    for (const [baseUrl, value] of Object.entries(candidate.credentials)) {
      if (!value || typeof value !== 'object') {
        corrupted = true;
        continue;
      }
      const entry = value as Partial<StoredCredential>;
      if (
        typeof entry.dd_ingest_token !== 'string' ||
        !entry.dd_ingest_token ||
        typeof entry.client_id !== 'string' ||
        !entry.client_id ||
        typeof entry.created_at !== 'string' ||
        !entry.created_at
      ) {
        corrupted = true;
        continue;
      }

      const environment = (Object.entries(OAUTH_BASE_URLS) as [DriftEnvironment, string][]).find(
        ([, oauthBaseUrl]) => oauthBaseUrl === baseUrl,
      )?.[0];
      const apiUrl = environment ? API_BASE_URLS[environment] : entry.apiUrl;
      if (typeof apiUrl !== 'string' || !apiUrl) {
        corrupted = true;
        continue;
      }

      credentials[baseUrl] = {
        apiUrl,
        dd_ingest_token: entry.dd_ingest_token,
        client_id: entry.client_id,
        created_at: entry.created_at,
      };
    }
    return { store: { version: 1, credentials }, corrupted };
  } catch {
    return { store: emptyCredentialsFile(), corrupted: true };
  }
}

/**
 * Missing, malformed, and schema-incompatible files behave like an empty
 * store for read-only consumers. Read/permission errors are rethrown.
 */
export function readCredentialsFile(path = getCredentialsPath()): CredentialsFile {
  return readCredentialsFileResult(path).store;
}

/**
 * Load credentials for a mutation. An invalid file is atomically moved aside
 * first so a successful login cannot destroy bytes that may be recoverable.
 */
export function prepareCredentialsFileWrite(
  path = getCredentialsPath(),
  onCorruptBackup?: (backupPath: string) => void,
): { store: CredentialsFile; corruptBackupPath?: string } {
  const result = readCredentialsFileResult(path);
  if (!result.corrupted) return { store: result.store };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let backupPath = `${path}.corrupt-${timestamp}`;
  if (existsSync(backupPath)) backupPath = `${backupPath}-${randomUUID()}`;
  renameSync(path, backupPath);
  chmodSync(backupPath, 0o600);
  onCorruptBackup?.(backupPath);

  const backupPrefix = `${basename(path)}.corrupt-`;
  const backups = readdirSync(dirname(path))
    .filter((name) => name.startsWith(backupPrefix))
    .sort()
    .reverse();
  for (const expiredBackup of backups.slice(3)) {
    unlinkSync(join(dirname(path), expiredBackup));
  }

  return { store: result.store, corruptBackupPath: backupPath };
}

// Auth mutations intentionally use an unlocked read-modify-write cycle. Two
// concurrent login/logout processes are therefore last-writer-wins; adding a
// cross-process lockfile is out of scope for this credentials format.

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
