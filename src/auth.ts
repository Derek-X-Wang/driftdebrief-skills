import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { platform } from 'node:os';

import {
  API_BASE_URLS,
  getCredentialsPath,
  OAUTH_BASE_URLS,
  readCredentialsFile,
  type DriftEnvironment,
  type StoredCredential,
  writeCredentialsFile,
} from './credentials';

interface AuthorizationServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

interface RegistrationResponse {
  client_id?: unknown;
}

interface TokenResponse {
  dd_ingest_token?: unknown;
  [key: string]: unknown;
}

interface LoginOptions {
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<boolean>;
  timeoutMs?: number;
  onAuthorizationUrl?: (url: string, browserOpened: boolean) => void;
}

interface LogoutOptions {
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  /** Test seam for a local HTTP server; production always uses API_BASE_URLS. */
  apiBaseUrl?: string;
}

export interface LoginResult {
  environment: DriftEnvironment;
  oauthBaseUrl: string;
  apiUrl: string;
  credentialsPath: string;
  credential: StoredCredential;
}

export interface LogoutResult {
  environment: DriftEnvironment;
  oauthBaseUrl: string;
  apiUrl: string;
  credentialsPath: string;
  removed: boolean;
  revokeWarning?: string;
}

interface AuthorizationCallback {
  code: string;
  respond: (status: number, title: string, message: string) => Promise<void>;
}

class OAuthEndpointError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OAuthEndpointError';
  }
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

function truncate(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function htmlPage(title: string, message: string): string {
  const escape = (value: string) =>
    value.replace(/[&<>"']/g, (character) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return entities[character]!;
    });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:42rem;margin:12vh auto;padding:0 1.5rem;line-height:1.5;color:#172033}main{border:1px solid #d9deea;border-radius:12px;padding:2rem;box-shadow:0 8px 30px #17203312}h1{margin-top:0}</style></head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p><p>You may close this window.</p></main></body></html>`;
}

async function createCallbackListener(expectedState: string, timeoutMs: number): Promise<{
  redirectUri: string;
  callback: Promise<AuthorizationCallback>;
  close: () => Promise<void>;
}> {
  let settle: ((result: AuthorizationCallback) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let settled = false;
  const pendingResponses = new Set<Promise<void>>();

  const callback = new Promise<AuthorizationCallback>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // A callback can arrive while metadata/DCR is still in flight. Attach the
  // rejection handler immediately so a rejected callback never crashes Bun as
  // an unhandled rejection before loginEnvironment reaches `await callback`.
  void callback.catch(() => undefined);

  const server = createServer((request, response) => {
    const send = (status: number, title: string, message: string): Promise<void> => {
      const pending = new Promise<void>((resolve, reject) => {
        response.once('finish', resolve);
        response.once('error', reject);
        response.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(htmlPage(title, message));
      });
      pendingResponses.add(pending);
      void pending.then(
        () => pendingResponses.delete(pending),
        () => pendingResponses.delete(pending),
      );
      return pending;
    };

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    // State is checked before `error`: an unrelated local request cannot
    // cancel the real login. Ignore it without settling the callback promise.
    if (url.searchParams.get('state') !== expectedState) {
      void send(
        400,
        'DriftDebrief callback ignored',
        'This callback did not match the pending login. The CLI is still waiting.',
      );
      return;
    }
    if (settled) {
      void send(409, 'Login already received', 'Return to the terminal to continue.');
      return;
    }

    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      settled = true;
      const description = truncate(url.searchParams.get('error_description'));
      void send(400, 'DriftDebrief login failed', description ?? oauthError);
      fail?.(
        new OAuthEndpointError(
          `OAuth authorization failed: ${description ?? oauthError}`,
          oauthError,
        ),
      );
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      settled = true;
      void send(
        400,
        'DriftDebrief login failed',
        'The authorization server did not return a code.',
      );
      fail?.(new Error('OAuth callback did not include an authorization code.'));
      return;
    }

    settled = true;
    settle?.({ code, respond: send });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not determine the OAuth callback port.');
  }

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    fail?.(new Error('Timed out waiting for the browser login callback.'));
  }, timeoutMs);
  timer.unref();
  void callback.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    callback,
    close: async () => {
      clearTimeout(timer);
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      // Do not reset the browser connection while its success/error page is
      // still flushing. Only force-close remaining keep-alive sockets after
      // every response has emitted `finish`.
      await Promise.allSettled([...pendingResponses]);
      server.closeAllConnections?.();
      await closed;
    },
  };
}

async function endpointJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    let errorCode: string | undefined;
    let description: string | undefined;
    try {
      const parsed = JSON.parse(await response.text()) as Record<string, unknown>;
      errorCode = truncate(parsed.error, 100);
      description = truncate(parsed.error_description);
    } catch {
      // Do not echo arbitrary endpoint bodies into stderr or the callback HTML.
    }
    const detail = [errorCode ? `error=${errorCode}` : undefined, description]
      .filter(Boolean)
      .join(': ');
    throw new OAuthEndpointError(
      `${label} failed: ${response.status}${detail ? ` ${detail}` : ''}`,
      errorCode,
      response.status,
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

async function fetchMetadata(
  oauthBaseUrl: string,
  fetchImpl: typeof fetch,
): Promise<AuthorizationServerMetadata> {
  const metadata = await endpointJson<AuthorizationServerMetadata>(
    await fetchImpl(`${oauthBaseUrl}/.well-known/oauth-authorization-server`),
    'OAuth metadata request',
  );
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error('OAuth metadata is missing the authorization or token endpoint.');
  }
  return metadata;
}

async function registerClient(
  metadata: AuthorizationServerMetadata,
  oauthBaseUrl: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const registrationEndpoint =
    metadata.registration_endpoint ?? `${oauthBaseUrl}/api/auth/oauth2/register`;
  const registration = await endpointJson<RegistrationResponse>(
    await fetchImpl(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'DriftDebrief CLI',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      }),
    }),
    'OAuth client registration',
  );
  if (typeof registration.client_id !== 'string' || !registration.client_id) {
    throw new Error('OAuth client registration did not return client_id.');
  }
  return registration.client_id;
}

export async function openSystemBrowser(url: string): Promise<boolean> {
  const command =
    platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'rundll32' : 'xdg-open';
  const args = platform() === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];

  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

function workspaceContext(token: TokenResponse): unknown {
  if (token.workspace !== undefined) return token.workspace;
  const context: Record<string, unknown> = {};
  for (const key of [
    'workspace_id',
    'workspaceId',
    'workspace_slug',
    'workspaceSlug',
    'workspace_name',
    'workspaceName',
  ]) {
    if (token[key] !== undefined) context[key] = token[key];
  }
  return Object.keys(context).length ? context : undefined;
}

export function selectAuthEnvironment(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DriftEnvironment {
  const selected = explicit ?? env.DRIFTDEBRIEF_ENV ?? 'prod';
  if (selected !== 'dev' && selected !== 'prod') {
    throw new Error(`Invalid environment "${selected}" — use "dev" or "prod".`);
  }
  return selected;
}

export function authEnvironmentFromArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): DriftEnvironment {
  const index = args.indexOf('--env');
  if (index < 0) return selectAuthEnvironment(undefined, env);
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--env requires a value: dev or prod.');
  }
  return selectAuthEnvironment(value, env);
}

export async function loginEnvironment(
  environment: DriftEnvironment,
  options: LoginOptions = {},
): Promise<LoginResult> {
  const oauthBaseUrl = OAUTH_BASE_URLS[environment];
  const apiUrl = API_BASE_URLS[environment];
  const credentialsPath = options.credentialsPath ?? getCredentialsPath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const openBrowser = options.openBrowser ?? openSystemBrowser;
  const existingStore = readCredentialsFile(credentialsPath);
  let clientId = existingStore.credentials[oauthBaseUrl]?.client_id;
  const metadata = await fetchMetadata(oauthBaseUrl, fetchImpl);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = base64Url(randomBytes(32));
    const codeVerifier = base64Url(randomBytes(48));
    const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
    const listener = await createCallbackListener(state, options.timeoutMs ?? 5 * 60_000);
    let callback: AuthorizationCallback | undefined;

    try {
      clientId ??= await registerClient(
        metadata,
        oauthBaseUrl,
        listener.redirectUri,
        fetchImpl,
      );

      const authorizationUrl = new URL(metadata.authorization_endpoint);
      authorizationUrl.searchParams.set('response_type', 'code');
      authorizationUrl.searchParams.set('client_id', clientId);
      authorizationUrl.searchParams.set('redirect_uri', listener.redirectUri);
      authorizationUrl.searchParams.set('scope', 'ingest_token');
      authorizationUrl.searchParams.set('state', state);
      authorizationUrl.searchParams.set('code_challenge', codeChallenge);
      authorizationUrl.searchParams.set('code_challenge_method', 'S256');

      const browserOpened = await openBrowser(authorizationUrl.toString());
      options.onAuthorizationUrl?.(authorizationUrl.toString(), browserOpened);
      callback = await listener.callback;

      const token = await endpointJson<TokenResponse>(
        await fetchImpl(metadata.token_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code: callback.code,
            redirect_uri: listener.redirectUri,
            code_verifier: codeVerifier,
          }),
        }),
        'OAuth token exchange',
      );
      if (typeof token.dd_ingest_token !== 'string' || !token.dd_ingest_token) {
        throw new Error('OAuth token response is missing dd_ingest_token.');
      }

      const workspace = workspaceContext(token);
      const credential: StoredCredential = {
        apiUrl,
        dd_ingest_token: token.dd_ingest_token,
        client_id: clientId,
        created_at: new Date().toISOString(),
        ...(workspace === undefined ? {} : { workspace }),
      };
      const currentStore = readCredentialsFile(credentialsPath);
      currentStore.credentials[oauthBaseUrl] = credential;
      writeCredentialsFile(currentStore, credentialsPath);
      await callback.respond(
        200,
        'DriftDebrief login complete',
        `The ${environment} credential is saved. Return to your terminal.`,
      );
      return { environment, oauthBaseUrl, apiUrl, credentialsPath, credential };
    } catch (error) {
      const invalidClient =
        error instanceof OAuthEndpointError && error.errorCode === 'invalid_client';
      if (invalidClient && attempt === 0) {
        if (callback) {
          await callback.respond(
            409,
            'Refreshing DriftDebrief login',
            'The saved OAuth client expired. A fresh authorization page is opening.',
          );
        }
        clientId = undefined;
        continue;
      }
      if (callback) {
        await callback.respond(500, 'DriftDebrief login failed', String(error));
      }
      throw error;
    } finally {
      await listener.close();
    }
  }

  throw new Error('OAuth login failed after refreshing the client registration.');
}

export async function logoutEnvironment(
  environment: DriftEnvironment,
  options: LogoutOptions = {},
): Promise<LogoutResult> {
  const oauthBaseUrl = OAUTH_BASE_URLS[environment];
  const apiUrl = options.apiBaseUrl ?? API_BASE_URLS[environment];
  const credentialsPath = options.credentialsPath ?? getCredentialsPath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const store = readCredentialsFile(credentialsPath);
  const credential = store.credentials[oauthBaseUrl];
  if (!credential) {
    return { environment, oauthBaseUrl, apiUrl, credentialsPath, removed: false };
  }

  let revokeWarning: string | undefined;
  try {
    const response = await fetchImpl(`${apiUrl}/api/tokens/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential.dd_ingest_token}` },
    });
    if (response.status === 200) {
      try {
        const result = (await response.json()) as { revoked?: unknown };
        if (result.revoked !== true) {
          revokeWarning =
            'Remote revoke returned an unexpected response — token may still be live; revoke in the web UI.';
        }
      } catch {
        revokeWarning =
          'Remote revoke returned an invalid response — token may still be live; revoke in the web UI.';
      }
    } else if (response.status === 401) {
      revokeWarning = 'Remote revoke returned 401 — token is unknown or already revoked.';
    } else if (response.status === 404) {
      revokeWarning =
        'server does not support remote revocation yet — token may still be live; revoke in the web UI';
    } else {
      revokeWarning = `Remote revoke failed with ${response.status} — token may still be live; revoke in the web UI.`;
    }
  } catch (error) {
    revokeWarning = `Remote revoke failed: ${String(error)} — token may still be live; revoke in the web UI.`;
  }

  delete store.credentials[oauthBaseUrl];
  if (Object.keys(store.credentials).length === 0) {
    try {
      unlinkSync(credentialsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } else {
    writeCredentialsFile(store, credentialsPath);
  }

  return {
    environment,
    oauthBaseUrl,
    apiUrl,
    credentialsPath,
    removed: true,
    revokeWarning,
  };
}
