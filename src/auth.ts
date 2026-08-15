import { createHash, randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { platform } from 'node:os';
import { spawn } from 'node:child_process';

import {
  ENVIRONMENT_BASE_URLS,
  getCredentialsPath,
  readCredentialsFile,
  type DriftEnvironment,
  type StoredCredential,
  writeCredentialsFile,
} from './credentials';

interface AuthorizationServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
}

interface RegistrationResponse {
  client_id: string;
}

interface TokenResponse {
  access_token: string;
  dd_ingest_token: string;
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
}

export interface LoginResult {
  environment: DriftEnvironment;
  baseUrl: string;
  credentialsPath: string;
  credential: StoredCredential;
}

export interface LogoutResult {
  environment: DriftEnvironment;
  baseUrl: string;
  credentialsPath: string;
  removed: boolean;
  revokeWarning?: string;
}

interface AuthorizationCallback {
  code: string;
  response: ServerResponse;
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
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

function respond(response: ServerResponse, status: number, title: string, message: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(htmlPage(title, message));
}

async function createCallbackListener(expectedState: string, timeoutMs: number): Promise<{
  redirectUri: string;
  callback: Promise<AuthorizationCallback>;
  close: () => Promise<void>;
}> {
  let settle: ((result: AuthorizationCallback) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let settled = false;

  const callback = new Promise<AuthorizationCallback>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    if (settled) {
      respond(response, 409, 'Login already received', 'Return to the terminal to continue.');
      return;
    }

    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      settled = true;
      const description = url.searchParams.get('error_description');
      respond(response, 400, 'DriftDebrief login cancelled', description ?? oauthError);
      fail?.(new Error(`OAuth authorization failed: ${description ?? oauthError}`));
      return;
    }

    if (url.searchParams.get('state') !== expectedState) {
      settled = true;
      respond(response, 400, 'DriftDebrief login failed', 'The callback state did not match. Please try again.');
      fail?.(new Error('OAuth callback state mismatch. Please run auth login again.'));
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      settled = true;
      respond(response, 400, 'DriftDebrief login failed', 'The authorization server did not return a code.');
      fail?.(new Error('OAuth callback did not include an authorization code.'));
      return;
    }

    settled = true;
    settle?.({ code, response });
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

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    callback: callback.finally(() => clearTimeout(timer)),
    close: async () => {
      clearTimeout(timer);
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function jsonResponse<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`${label} failed: ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

async function fetchMetadata(baseUrl: string, fetchImpl: typeof fetch): Promise<AuthorizationServerMetadata> {
  const metadata = await jsonResponse<AuthorizationServerMetadata>(
    await fetchImpl(`${baseUrl}/.well-known/oauth-authorization-server`),
    'OAuth metadata request',
  );
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error('OAuth metadata is missing the authorization or token endpoint.');
  }
  return metadata;
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

export async function loginEnvironment(
  environment: DriftEnvironment,
  options: LoginOptions = {},
): Promise<LoginResult> {
  const baseUrl = ENVIRONMENT_BASE_URLS[environment];
  const credentialsPath = options.credentialsPath ?? getCredentialsPath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const openBrowser = options.openBrowser ?? openSystemBrowser;
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(48));
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const listener = await createCallbackListener(state, options.timeoutMs ?? 5 * 60_000);
  let callback: AuthorizationCallback | undefined;

  try {
    const metadata = await fetchMetadata(baseUrl, fetchImpl);
    const registrationEndpoint =
      metadata.registration_endpoint ?? `${baseUrl}/api/auth/oauth2/register`;
    const registration = await jsonResponse<RegistrationResponse>(
      await fetchImpl(registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'DriftDebrief CLI',
          redirect_uris: [listener.redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
          response_types: ['code'],
        }),
      }),
      'OAuth client registration',
    );
    if (!registration.client_id) throw new Error('OAuth client registration did not return client_id.');

    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', registration.client_id);
    authorizationUrl.searchParams.set('redirect_uri', listener.redirectUri);
    authorizationUrl.searchParams.set('scope', 'ingest_token');
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge', codeChallenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');

    const browserOpened = await openBrowser(authorizationUrl.toString());
    options.onAuthorizationUrl?.(authorizationUrl.toString(), browserOpened);
    callback = await listener.callback;

    const token = await jsonResponse<TokenResponse>(
      await fetchImpl(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: registration.client_id,
          code: callback.code,
          redirect_uri: listener.redirectUri,
          code_verifier: codeVerifier,
        }),
      }),
      'OAuth token exchange',
    );
    if (!token.access_token || !token.dd_ingest_token) {
      throw new Error('OAuth token response is missing access_token or dd_ingest_token.');
    }

    const workspace = workspaceContext(token);
    const credential: StoredCredential = {
      dd_ingest_token: token.dd_ingest_token,
      access_token: token.access_token,
      client_id: registration.client_id,
      created_at: new Date().toISOString(),
      ...(workspace === undefined ? {} : { workspace }),
    };
    const store = readCredentialsFile(credentialsPath);
    store.credentials[baseUrl] = credential;
    writeCredentialsFile(store, credentialsPath);
    respond(
      callback.response,
      200,
      'DriftDebrief login complete',
      `The ${environment} credential is saved. Return to your terminal.`,
    );
    return { environment, baseUrl, credentialsPath, credential };
  } catch (error) {
    if (callback && !callback.response.writableEnded) {
      respond(callback.response, 500, 'DriftDebrief login failed', String(error));
    }
    throw error;
  } finally {
    await listener.close();
  }
}

export async function logoutEnvironment(
  environment: DriftEnvironment,
  options: LogoutOptions = {},
): Promise<LogoutResult> {
  const baseUrl = ENVIRONMENT_BASE_URLS[environment];
  const credentialsPath = options.credentialsPath ?? getCredentialsPath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const store = readCredentialsFile(credentialsPath);
  const credential = store.credentials[baseUrl];
  if (!credential) return { environment, baseUrl, credentialsPath, removed: false };

  let revokeWarning: string | undefined;
  try {
    const metadata = await fetchMetadata(baseUrl, fetchImpl);
    const revokeEndpoint = metadata.revocation_endpoint ?? `${baseUrl}/api/auth/oauth2/revoke`;
    const response = await fetchImpl(revokeEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: credential.access_token,
        token_type_hint: 'access_token',
        client_id: credential.client_id,
      }),
    });
    if (!response.ok) revokeWarning = `Remote revoke failed: ${response.status} ${await response.text()}`;
  } catch (error) {
    revokeWarning = `Remote revoke failed: ${String(error)}`;
  }

  delete store.credentials[baseUrl];
  if (Object.keys(store.credentials).length === 0) {
    try {
      unlinkSync(credentialsPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  } else {
    writeCredentialsFile(store, credentialsPath);
  }

  return { environment, baseUrl, credentialsPath, removed: true, revokeWarning };
}
