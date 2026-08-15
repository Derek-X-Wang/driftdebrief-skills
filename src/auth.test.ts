import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authEnvironmentFromArgs, loginEnvironment, logoutEnvironment } from './auth';
import {
  API_BASE_URLS,
  OAUTH_BASE_URLS,
  readCredentialsFile,
  type DriftEnvironment,
  type StoredCredential,
  writeCredentialsFile,
} from './credentials';

function stored(
  token: string,
  environment: DriftEnvironment = 'prod',
  clientId = `client_${token}`,
): StoredCredential {
  return {
    apiUrl: API_BASE_URLS[environment],
    dd_ingest_token: `dd_${token}`,
    client_id: clientId,
    created_at: '2026-08-15T00:00:00.000Z',
  };
}

async function startRevokeServer(status: number): Promise<{
  baseUrl: string;
  request: Promise<{ method?: string; url?: string; authorization?: string; body: string }>;
  close: () => Promise<void>;
}> {
  let capture: (
    request: { method?: string; url?: string; authorization?: string; body: string },
  ) => void;
  const request = new Promise<{
    method?: string;
    url?: string;
    authorization?: string;
    body: string;
  }>((resolve) => {
    capture = resolve;
  });
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    capture({
      method: incoming.method,
      url: incoming.url,
      authorization: incoming.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(status === 200 ? { revoked: true } : { error: 'not_revoked' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock server did not bind TCP.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    request,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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

  it('uses DCR + PKCE S256 + ingest_token scope and stores only the long-lived credential', async () => {
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
          access_token: 'short-lived-and-ignored',
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
    expect(result).toMatchObject({
      oauthBaseUrl: OAUTH_BASE_URLS.prod,
      apiUrl: API_BASE_URLS.prod,
    });
    expect(result.credential).toMatchObject({
      apiUrl: API_BASE_URLS.prod,
      dd_ingest_token: 'dd_from_grant',
      client_id: 'public-client',
      workspace: { id: 'workspace-1', name: 'Example' },
    });
    expect(result.credential).not.toHaveProperty('access_token');
    expect(readCredentialsFile(credentialsPath).credentials[OAUTH_BASE_URLS.prod]).toEqual(
      result.credential,
    );
  });

  it('ignores unmatched-state errors and continues waiting for the real callback', async () => {
    let ignoredResponse: Promise<Response> | undefined;
    let acceptedResponse: Promise<Response> | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          authorization_endpoint: 'https://auth.example/authorize',
          token_endpoint: 'https://auth.example/token',
          registration_endpoint: 'https://auth.example/register',
        });
      }
      if (url === 'https://auth.example/register') return Response.json({ client_id: 'client' });
      if (url === 'https://auth.example/token') {
        return Response.json({ dd_ingest_token: 'dd_after_ignored_callback' });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const result = await loginEnvironment('prod', {
      credentialsPath,
      fetchImpl,
      openBrowser: async (url) => {
        const authorizationUrl = new URL(url);
        const redirectUri = authorizationUrl.searchParams.get('redirect_uri')!;
        const ignored = new URL(redirectUri);
        ignored.searchParams.set('state', 'wrong-state');
        ignored.searchParams.set('error', 'access_denied');
        ignoredResponse = fetch(ignored);
        expect((await ignoredResponse).status).toBe(400);

        const accepted = new URL(redirectUri);
        accepted.searchParams.set('state', authorizationUrl.searchParams.get('state')!);
        accepted.searchParams.set('code', 'authorization-code');
        acceptedResponse = fetch(accepted);
        return true;
      },
    });

    expect(result.credential.dd_ingest_token).toBe('dd_after_ignored_callback');
    expect((await acceptedResponse!).status).toBe(200);
  });

  it('aborts cleanly without writing when a 200 token response omits dd_ingest_token', async () => {
    let callbackResponse: Promise<Response> | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          authorization_endpoint: 'https://auth.example/authorize',
          token_endpoint: 'https://auth.example/token',
          registration_endpoint: 'https://auth.example/register',
        });
      }
      if (url === 'https://auth.example/register') return Response.json({ client_id: 'client' });
      if (url === 'https://auth.example/token') {
        return Response.json({ access_token: 'not-useful-without-dd-token' });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const login = loginEnvironment('prod', {
      credentialsPath,
      fetchImpl,
      openBrowser: async (url) => {
        const authorizationUrl = new URL(url);
        const callbackUrl = new URL(authorizationUrl.searchParams.get('redirect_uri')!);
        callbackUrl.searchParams.set('state', authorizationUrl.searchParams.get('state')!);
        callbackUrl.searchParams.set('code', 'authorization-code');
        callbackResponse = fetch(callbackUrl);
        return true;
      },
    });

    await expect(login).rejects.toThrow('missing dd_ingest_token');
    expect((await callbackResponse!).status).toBe(500);
    expect(existsSync(credentialsPath)).toBe(false);
  });

  it('backs up a corrupted credentials file before a successful login and warns', async () => {
    const corruptedContents =
      '{"version":1,"credentials":{"https://dev.driftdebrief.derekxwang.com":{"dd_ingest_token":"dd_dev_recoverable"}}';
    writeFileSync(credentialsPath, corruptedContents);
    const warnings: string[] = [];
    let callbackResponse: Promise<Response> | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          authorization_endpoint: 'https://auth.example/authorize',
          token_endpoint: 'https://auth.example/token',
          registration_endpoint: 'https://auth.example/register',
        });
      }
      if (url === 'https://auth.example/register') return Response.json({ client_id: 'client' });
      if (url === 'https://auth.example/token') {
        return Response.json({ dd_ingest_token: 'dd_new_prod' });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    await loginEnvironment('prod', {
      credentialsPath,
      fetchImpl,
      onWarning: (message) => warnings.push(message),
      openBrowser: async (url) => {
        const authorizationUrl = new URL(url);
        const callbackUrl = new URL(authorizationUrl.searchParams.get('redirect_uri')!);
        callbackUrl.searchParams.set('state', authorizationUrl.searchParams.get('state')!);
        callbackUrl.searchParams.set('code', 'authorization-code');
        callbackResponse = fetch(callbackUrl);
        return true;
      },
    });

    expect((await callbackResponse!).status).toBe(200);
    const backupName = readdirSync(directory).find((name) =>
      name.startsWith('credentials.json.corrupt-'),
    );
    expect(backupName).toBeTruthy();
    const backupPath = join(directory, backupName!);
    expect(readFileSync(backupPath, 'utf8')).toBe(corruptedContents);
    expect(warnings).toEqual([
      expect.stringContaining(`preserved at ${backupPath}`),
    ]);
    expect(readCredentialsFile(credentialsPath).credentials[OAUTH_BASE_URLS.prod]).toMatchObject({
      dd_ingest_token: 'dd_new_prod',
    });
  });

  it('times out an abandoned browser login without writing credentials', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          authorization_endpoint: 'https://auth.example/authorize',
          token_endpoint: 'https://auth.example/token',
          registration_endpoint: 'https://auth.example/register',
        });
      }
      if (url === 'https://auth.example/register') return Response.json({ client_id: 'client' });
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      loginEnvironment('prod', {
        credentialsPath,
        fetchImpl,
        openBrowser: async () => true,
        timeoutMs: 10,
      }),
    ).rejects.toThrow('Timed out waiting');
    expect(existsSync(credentialsPath)).toBe(false);
  });

  it('reuses a persisted client_id without another DCR registration', async () => {
    writeCredentialsFile(
      {
        version: 1,
        credentials: {
          [OAUTH_BASE_URLS.prod]: stored('old', 'prod', 'persisted-client'),
        },
      },
      credentialsPath,
    );
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
      expect(url).toBe('https://auth.example/token');
      expect((init?.body as URLSearchParams).get('client_id')).toBe('persisted-client');
      return Response.json({ dd_ingest_token: 'dd_relogin' });
    }) as unknown as typeof fetch;

    const result = await loginEnvironment('prod', {
      credentialsPath,
      fetchImpl,
      openBrowser: async (url) => {
        const authorizationUrl = new URL(url);
        expect(authorizationUrl.searchParams.get('client_id')).toBe('persisted-client');
        const callbackUrl = new URL(authorizationUrl.searchParams.get('redirect_uri')!);
        callbackUrl.searchParams.set('state', authorizationUrl.searchParams.get('state')!);
        callbackUrl.searchParams.set('code', 'authorization-code');
        callbackResponse = fetch(callbackUrl);
        return true;
      },
    });

    expect((await callbackResponse!).status).toBe(200);
    expect(result.credential.client_id).toBe('persisted-client');
    expect(result.credential.dd_ingest_token).toBe('dd_relogin');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('re-registers once when a persisted client receives invalid_client', async () => {
    writeCredentialsFile(
      {
        version: 1,
        credentials: {
          [OAUTH_BASE_URLS.prod]: stored('old', 'prod', 'expired-client'),
        },
      },
      credentialsPath,
    );
    let tokenCalls = 0;
    let registerCalls = 0;
    const callbackResponses: Promise<Response>[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          authorization_endpoint: 'https://auth.example/authorize',
          token_endpoint: 'https://auth.example/token',
          registration_endpoint: 'https://auth.example/register',
        });
      }
      if (url === 'https://auth.example/register') {
        registerCalls += 1;
        return Response.json({ client_id: 'replacement-client' });
      }
      if (url === 'https://auth.example/token') {
        tokenCalls += 1;
        return tokenCalls === 1
          ? Response.json(
              {
                error: 'invalid_client',
                error_description: 'expired client',
                secretPayload: 'must never be rendered',
              },
              { status: 401 },
            )
          : Response.json({ dd_ingest_token: 'dd_after_reregister' });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const result = await loginEnvironment('prod', {
      credentialsPath,
      fetchImpl,
      openBrowser: async (url) => {
        const authorizationUrl = new URL(url);
        const callbackUrl = new URL(authorizationUrl.searchParams.get('redirect_uri')!);
        callbackUrl.searchParams.set('state', authorizationUrl.searchParams.get('state')!);
        callbackUrl.searchParams.set('code', 'authorization-code');
        callbackResponses.push(fetch(callbackUrl));
        return true;
      },
    });

    expect(registerCalls).toBe(1);
    expect(tokenCalls).toBe(2);
    expect(result.credential).toMatchObject({
      client_id: 'replacement-client',
      dd_ingest_token: 'dd_after_reregister',
    });
    expect((await callbackResponses[0]!).status).toBe(409);
    expect(await (await callbackResponses[0]!).text()).not.toContain('secretPayload');
    expect((await callbackResponses[1]!).status).toBe(200);
  });

  it.each([
    { status: 200, warning: undefined },
    { status: 401, warning: 'unknown or already revoked' },
    {
      status: 404,
      warning:
        'server does not support remote revocation yet — token may still be live; revoke in the web UI',
    },
  ])(
    'POSTs the dd token to the revoke endpoint and deletes only that env on $status',
    async ({ status, warning }) => {
      writeCredentialsFile(
        {
          version: 1,
          credentials: {
            [OAUTH_BASE_URLS.dev]: stored('dev', 'dev'),
            [OAUTH_BASE_URLS.prod]: stored('prod'),
          },
        },
        credentialsPath,
      );
      const mock = await startRevokeServer(status);
      try {
        const result = await logoutEnvironment('prod', {
          credentialsPath,
          apiBaseUrl: mock.baseUrl,
        });
        expect(result.removed).toBe(true);
        if (warning) expect(result.revokeWarning).toContain(warning);
        else expect(result.revokeWarning).toBeUndefined();
        expect(await mock.request).toEqual({
          method: 'POST',
          url: '/api/tokens/revoke',
          authorization: 'Bearer dd_prod',
          body: '',
        });
        const remaining = readCredentialsFile(credentialsPath).credentials;
        expect(remaining[OAUTH_BASE_URLS.prod]).toBeUndefined();
        expect(remaining[OAUTH_BASE_URLS.dev]).toEqual(stored('dev', 'dev'));
      } finally {
        await mock.close();
      }
    },
  );

  it('warns on a revoke network failure and still removes the local entry', async () => {
    writeCredentialsFile(
      {
        version: 1,
        credentials: { [OAUTH_BASE_URLS.prod]: stored('prod') },
      },
      credentialsPath,
    );
    const mock = await startRevokeServer(200);
    await mock.close();

    const result = await logoutEnvironment('prod', {
      credentialsPath,
      apiBaseUrl: mock.baseUrl,
    });
    expect(result.removed).toBe(true);
    expect(result.revokeWarning).toContain('Remote revoke failed');
    expect(existsSync(credentialsPath)).toBe(false);
  });

  it('rejects a valueless --env flag', () => {
    expect(() => authEnvironmentFromArgs(['--env'], {})).toThrow('--env requires a value');
    expect(() => authEnvironmentFromArgs(['--env', '--other'], {})).toThrow(
      '--env requires a value',
    );
  });
});
