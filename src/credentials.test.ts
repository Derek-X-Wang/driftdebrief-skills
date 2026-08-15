import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  API_BASE_URLS,
  getCredentialsPath,
  OAUTH_BASE_URLS,
  readCredentialsFile,
  writeCredentialsFile,
} from './credentials';

describe('credentials file', () => {
  let directory: string;
  let credentialsPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'driftdebrief-credentials-'));
    credentialsPath = join(directory, 'nested', 'credentials.json');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('reasserts 0600 when rewriting a pre-existing 0644 file', () => {
    mkdirSync(dirname(credentialsPath), { recursive: true });
    writeFileSync(credentialsPath, '{"version":1,"credentials":{}}', { mode: 0o644 });
    chmodSync(credentialsPath, 0o644);
    writeCredentialsFile({ version: 1, credentials: {} }, credentialsPath);
    expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
  });

  it('reasserts 0700 on an existing config directory', () => {
    mkdirSync(dirname(credentialsPath), { recursive: true, mode: 0o755 });
    chmodSync(dirname(credentialsPath), 0o755);
    writeCredentialsFile({ version: 1, credentials: {} }, credentialsPath);
    expect(statSync(dirname(credentialsPath)).mode & 0o777).toBe(0o700);
  });

  it('tolerates a missing file', () => {
    expect(readCredentialsFile(credentialsPath)).toEqual({ version: 1, credentials: {} });
  });

  it('rethrows non-ENOENT read errors', () => {
    mkdirSync(dirname(credentialsPath), { recursive: true });
    mkdirSync(credentialsPath);
    expect(() => readCredentialsFile(credentialsPath)).toThrow();
  });

  it('honors XDG_CONFIG_HOME', () => {
    expect(getCredentialsPath({ XDG_CONFIG_HOME: directory, HOME: '/ignored' })).toBe(
      join(directory, 'driftdebrief', 'credentials.json'),
    );
  });

  it('normalizes legacy entries to the fixed Convex API origin without access_token', () => {
    mkdirSync(dirname(credentialsPath), { recursive: true });
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        version: 1,
        credentials: {
          [OAUTH_BASE_URLS.prod]: {
            dd_ingest_token: 'dd_legacy',
            access_token: 'ignored',
            client_id: 'client',
            created_at: '2026-08-15T00:00:00.000Z',
          },
        },
      }),
    );
    expect(readCredentialsFile(credentialsPath).credentials[OAUTH_BASE_URLS.prod]).toEqual({
      apiUrl: API_BASE_URLS.prod,
      dd_ingest_token: 'dd_legacy',
      client_id: 'client',
      created_at: '2026-08-15T00:00:00.000Z',
    });
  });
});
