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
import { randomUUID } from 'node:crypto';

export type DriftEnvironment = 'dev' | 'prod';

export const ENVIRONMENT_BASE_URLS: Record<DriftEnvironment, string> = {
  dev: 'https://dev.driftdebrief.derekxwang.com',
  prod: 'https://driftdebrief.derekxwang.com',
};

export interface StoredCredential {
  dd_ingest_token: string;
  access_token: string;
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
  return join(env.HOME || homedir(), '.config', 'driftdebrief', 'credentials.json');
}

/**
 * Read credentials without ever making normal CLI startup fail. Missing,
 * unreadable, malformed, and schema-incompatible files behave like an empty
 * store; `auth login` will replace them with a valid file on its next write.
 */
export function readCredentialsFile(path = getCredentialsPath()): CredentialsFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyCredentialsFile();
    const candidate = parsed as Partial<CredentialsFile>;
    if (candidate.version !== 1 || !candidate.credentials || typeof candidate.credentials !== 'object') {
      return emptyCredentialsFile();
    }

    const credentials: Record<string, StoredCredential> = {};
    for (const [baseUrl, value] of Object.entries(candidate.credentials)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Partial<StoredCredential>;
      if (
        !entry.dd_ingest_token ||
        !entry.access_token ||
        !entry.client_id ||
        !entry.created_at
      ) {
        continue;
      }
      credentials[baseUrl] = entry as StoredCredential;
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
  return readCredentialsFile(path).credentials[ENVIRONMENT_BASE_URLS[environment]];
}

export function maskToken(token?: string): string {
  if (!token) return '(not set)';
  if (token.length <= 8) return `${token.slice(0, 2)}… (${token.length} chars)`;
  return `${token.slice(0, 3)}…${token.slice(-4)} (${token.length} chars)`;
}
