import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveEnv } from './config';
import { API_BASE_URLS, OAUTH_BASE_URLS, writeCredentialsFile } from './credentials';

const PAIRS = {
  DRIFTDEBRIEF_API_URL_DEV: 'https://dev.convex.site',
  DRIFTDEBRIEF_TOKEN_DEV: 'dd_dev_token',
  DRIFTDEBRIEF_API_URL_PROD: 'https://prod.convex.site',
  DRIFTDEBRIEF_TOKEN_PROD: 'dd_prod_token',
};

describe('resolveEnv', () => {
  let directory: string;
  let credentialsPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'driftdebrief-config-'));
    credentialsPath = join(directory, 'credentials.json');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const resolve = (env: NodeJS.ProcessEnv) => resolveEnv(env, credentialsPath);

  it('defaults to prod when DRIFTDEBRIEF_ENV is unset and both pairs exist', () => {
    const r = resolve({ ...PAIRS });
    expect(r).toMatchObject({
      selected: 'prod',
      defaulted: true,
      source: 'profile',
      apiUrl: 'https://prod.convex.site',
      token: 'dd_prod_token',
    });
    expect(r.error).toBeUndefined();
  });

  it('selects the dev pair when DRIFTDEBRIEF_ENV=dev', () => {
    const r = resolve({ ...PAIRS, DRIFTDEBRIEF_ENV: 'dev' });
    expect(r).toMatchObject({
      selected: 'dev',
      defaulted: false,
      source: 'profile',
      apiUrl: 'https://dev.convex.site',
      token: 'dd_dev_token',
    });
  });

  it('selects the prod pair when DRIFTDEBRIEF_ENV=prod (not defaulted)', () => {
    const r = resolve({ ...PAIRS, DRIFTDEBRIEF_ENV: 'prod' });
    expect(r).toMatchObject({ selected: 'prod', defaulted: false });
  });

  it('bare DRIFTDEBRIEF_API_URL + TOKEN override the profiles as custom', () => {
    const r = resolve({
      ...PAIRS,
      DRIFTDEBRIEF_ENV: 'dev',
      DRIFTDEBRIEF_API_URL: 'https://custom.convex.site',
      DRIFTDEBRIEF_TOKEN: 'dd_custom',
    });
    expect(r).toMatchObject({
      selected: 'custom',
      source: 'env',
      apiUrl: 'https://custom.convex.site',
      token: 'dd_custom',
    });
    expect(r.error).toBeUndefined();
  });

  it('errors when only one bare var is set (no silent half-profile mix)', () => {
    const r = resolve({ ...PAIRS, DRIFTDEBRIEF_API_URL: 'https://custom.convex.site' });
    expect(r.selected).toBe('custom');
    expect(r.error).toContain('DRIFTDEBRIEF_TOKEN');
  });

  it('errors naming the exact missing vars for the selected profile', () => {
    const r = resolve({ DRIFTDEBRIEF_ENV: 'dev', DRIFTDEBRIEF_TOKEN_DEV: 'dd_dev' });
    expect(r.selected).toBe('dev');
    expect(r.error).toContain('DRIFTDEBRIEF_API_URL_DEV');
    expect(r.error).not.toContain('DRIFTDEBRIEF_TOKEN_DEV');
  });

  it('falls through to the credentials file when the default prod pair is absent', () => {
    writeCredentialsFile(
      {
        version: 1,
        credentials: {
          [OAUTH_BASE_URLS.prod]: {
            apiUrl: API_BASE_URLS.prod,
            dd_ingest_token: 'dd_file_prod',
            client_id: 'client_prod',
            created_at: '2026-08-15T00:00:00.000Z',
          },
        },
      },
      credentialsPath,
    );
    const r = resolve({});
    expect(r).toMatchObject({
      selected: 'prod',
      defaulted: true,
      source: 'credentials-file',
      apiUrl: API_BASE_URLS.prod,
      token: 'dd_file_prod',
      credentialsPath,
    });
    expect(r.error).toBeUndefined();
  });

  it('selects the dev credentials-file entry when DRIFTDEBRIEF_ENV=dev', () => {
    writeCredentialsFile(
      {
        version: 1,
        credentials: {
          [OAUTH_BASE_URLS.dev]: {
            apiUrl: API_BASE_URLS.dev,
            dd_ingest_token: 'dd_file_dev',
            client_id: 'client_dev',
            created_at: '2026-08-15T00:00:00.000Z',
          },
        },
      },
      credentialsPath,
    );
    expect(resolve({ DRIFTDEBRIEF_ENV: 'dev' })).toMatchObject({
      selected: 'dev',
      defaulted: false,
      source: 'credentials-file',
      apiUrl: API_BASE_URLS.dev,
      token: 'dd_file_dev',
    });
  });

  it('profile pairs take precedence over the credentials file', () => {
    writeCredentialsFile(
      {
        version: 1,
        credentials: {
          [OAUTH_BASE_URLS.prod]: {
            apiUrl: API_BASE_URLS.prod,
            dd_ingest_token: 'dd_file_prod',
            client_id: 'client_prod',
            created_at: '2026-08-15T00:00:00.000Z',
          },
        },
      },
      credentialsPath,
    );
    expect(resolve({ ...PAIRS })).toMatchObject({ source: 'profile', token: 'dd_prod_token' });
  });

  it('missing credentials file is tolerated and returns a friendly login error', () => {
    const r = resolve({});
    expect(r).toMatchObject({ selected: 'prod', defaulted: true });
    expect(r.source).toBe('credentials-file');
    expect(r.error).toContain('auth login');
  });

  it('rejects an invalid DRIFTDEBRIEF_ENV value', () => {
    const r = resolve({ ...PAIRS, DRIFTDEBRIEF_ENV: 'staging' });
    expect(r.error).toContain('"staging"');
    expect(r.error).toContain('"dev" or "prod"');
  });

  it('partial profile pair reports only the missing var', () => {
    const r = resolve({ DRIFTDEBRIEF_ENV: 'prod', DRIFTDEBRIEF_API_URL_PROD: 'https://p.site' });
    expect(r.error).toContain('DRIFTDEBRIEF_TOKEN_PROD');
    expect(r.error).not.toContain('DRIFTDEBRIEF_API_URL_PROD and');
  });

  it('keeps empty profile variables in the profile tier instead of falling through', () => {
    const r = resolve({ DRIFTDEBRIEF_API_URL_PROD: '', DRIFTDEBRIEF_TOKEN_PROD: '' });
    expect(r.source).toBe('profile');
    expect(r.error).toContain('DRIFTDEBRIEF_API_URL_PROD');
    expect(r.error).toContain('DRIFTDEBRIEF_TOKEN_PROD');
  });

  it('corrupted credentials file is tolerated', () => {
    writeFileSync(credentialsPath, '{ definitely not json');
    expect(() => resolve({})).not.toThrow();
    expect(resolve({}).error).toContain('auth login');
  });
});
