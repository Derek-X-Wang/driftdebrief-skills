import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loginEnvironment, logoutEnvironment } from './auth';
import {
  ENVIRONMENT_BASE_URLS,
  readCredentialsFile,
  type StoredCredential,
  writeCredentialsFile,
} from './credentials';

function stored(token: string): StoredCredential {
  return {
    dd_ingest_token: `dd_${token}`,
    access_token: `access_${token}`,
    client_id: `client_${token}`,
    created_at: '2026-08-15T00:00:00.000Z',
  };
}

describe('OAuth credentials', () => {
  let directory: string;
  let credentialsPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'driftdebrief-auth-'));
    credentialsPath = join(directory, 'credentials.json');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('uses DCR + PKCE S256 + ingest_token scope and stores the returned dd credential', async () => {
    let redirectUri = '';
    let callbackResponse: Promise<Response> | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          authorization_endpoint: 'https://auth.example/authorize',
          token_endpoint: 'https://auth.example/token',
          registration_endpoint: 'https://auth.example/register',
        });
      }
      if (url === 'https://auth.example/register') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
        });
        redirectUri = (body.redirect_uris as string[])[0]!;
        expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        return Response.json({ client_id: 'public-client' });
      }
      if (url === 'https://auth.example/token') {
        const body = init?.body as URLSearchParams;
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('client_id')).toBe('public-client');
        expect(body.get('redirect_uri')).toBe(redirectUri);
        expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,}$/);
        return Response.json({
          access_token: 'access-from-grant',
          dd_ingest_token: 'dd_from_grant',
          workspace: { id: 'workspace-1', name: 'Example' },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const result = await loginEnvironment('prod', {
      credentialsPath,
      fetchImpl,
      openBrowser: async (url) => {
        const authorizationUrl = new URL(url);
        expect(authorizationUrl.searchParams.get('scope')).toBe('ingest_token');
        expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy();
        expect(authorizationUrl.searchParams.get('code_verifier')).toBeNull();
        const callbackUrl = new URL(authorizationUrl.searchParams.get('redirect_uri')!);
        callbackUrl.searchParams.set('code', 'authorization-code');
        callbackUrl.searchParams.set('state', authorizationUrl.searchParams.get('state')!);
        callbackResponse = fetch(callbackUrl);
        return true;
      },
    });

    expect((await callbackResponse!).status).toBe(200);
    expect(result.credential).toMatchObject({
      dd_ingest_token: 'dd_from_grant',
      access_token: 'access-from-grant',
      client_id: 'public-client',
      workspace: { id: 'workspace-1', name: 'Example' },
    });
    expect(readCredentialsFile(credentialsPath).credentials[ENVIRONMENT_BASE_URLS.prod]).toEqual(
      result.credential,
    );
  });

  it('rejects a loopback callback whose state does not match', async () => {
    let callbackResponse: Promise<Response> | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          authorization_endpoint: 'https://auth.example/authorize',
          token_endpoint: 'https://auth.example/token',
          registration_endpoint: 'https://auth.example/register',
        });
      }
      if (url === 'https://auth.example/register') {
        const body = JSON.parse(String(init?.body)) as { redirect_uris: string[] };
        expect(body.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        return Response.json({ client_id: 'public-client' });
      }
      throw new Error(`Token endpoint must not be called after a state mismatch: ${url}`);
    }) as unknown as typeof fetch;

    const login = loginEnvironment('prod', {
      credentialsPath,
      fetchImpl,
      openBrowser: async (url) => {
        const authorizationUrl = new URL(url);
        const callbackUrl = new URL(authorizationUrl.searchParams.get('redirect_uri')!);
        callbackUrl.searchParams.set('code', 'authorization-code');
        callbackUrl.searchParams.set('state', 'wrong-state');
        callbackResponse = fetch(callbackUrl);
        return true;
      },
    });

    await expect(login).rejects.toThrow('state mismatch');
    expect((await callbackResponse!).status).toBe(400);
    expect(existsSync(credentialsPath)).toBe(false);
  });

  it('logout revokes the grant and removes only the selected environment entry', async () => {
    writeCredentialsFile(
      {
        version: 1,
        credentials: {
          [ENVIRONMENT_BASE_URLS.dev]: stored('dev'),
          [ENVIRONMENT_BASE_URLS.prod]: stored('prod'),
        },
      },
      credentialsPath,
    );
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          authorization_endpoint: `${ENVIRONMENT_BASE_URLS.prod}/api/auth/oauth2/authorize`,
          token_endpoint: `${ENVIRONMENT_BASE_URLS.prod}/api/auth/oauth2/token`,
          revocation_endpoint: `${ENVIRONMENT_BASE_URLS.prod}/api/auth/oauth2/revoke`,
        });
      }
      expect(url).toBe(`${ENVIRONMENT_BASE_URLS.prod}/api/auth/oauth2/revoke`);
      const body = init?.body as URLSearchParams;
      expect(body.get('token')).toBe('access_prod');
      expect(body.get('client_id')).toBe('client_prod');
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await logoutEnvironment('prod', { credentialsPath, fetchImpl });
    expect(result).toMatchObject({ removed: true, revokeWarning: undefined });
    const remaining = readCredentialsFile(credentialsPath).credentials;
    expect(remaining[ENVIRONMENT_BASE_URLS.prod]).toBeUndefined();
    expect(remaining[ENVIRONMENT_BASE_URLS.dev]).toEqual(stored('dev'));
  });

  it('removes the credentials file after logging out of the final environment', async () => {
    writeCredentialsFile(
      {
        version: 1,
        credentials: { [ENVIRONMENT_BASE_URLS.prod]: stored('prod') },
      },
      credentialsPath,
    );
    const offline = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    const result = await logoutEnvironment('prod', { credentialsPath, fetchImpl: offline });
    expect(result.removed).toBe(true);
    expect(result.revokeWarning).toContain('offline');
    expect(existsSync(credentialsPath)).toBe(false);
  });
});
