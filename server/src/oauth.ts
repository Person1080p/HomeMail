import crypto from 'node:crypto';
import { config } from './config.js';
import { type AccountRow, type AccountSecret, getAccountById, readSecret, writeSecret } from './accounts.js';
import { HttpError, badRequest } from './http.js';

export type OAuthProviderId = 'google' | 'microsoft';
/** Mail accounts and calendar accounts sign in separately, each asking only for its own scopes. */
export type OAuthPurpose = 'mail' | 'calendar';

interface ProviderDef {
  authUrl: string;
  tokenUrl: string;
  scope: string;
  clientId: string;
  clientSecret: string;
  extraAuthParams: Record<string, string>;
  /** Microsoft wants the scope repeated on refresh. */
  scopeOnRefresh: boolean;
}

function provider(id: OAuthProviderId, purpose: OAuthPurpose = 'mail'): ProviderDef {
  if (id === 'google' && config.google) {
    return {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scope: purpose === 'calendar' ? 'openid email profile https://www.googleapis.com/auth/calendar' : 'openid email profile https://mail.google.com/',
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
      scopeOnRefresh: false,
    };
  }
  if (id === 'microsoft' && config.microsoft) {
    const base = `https://login.microsoftonline.com/${encodeURIComponent(config.microsoft.tenant)}/oauth2/v2.0`;
    return {
      authUrl: `${base}/authorize`,
      tokenUrl: `${base}/token`,
      scope:
        purpose === 'calendar'
          ? 'openid email profile offline_access https://graph.microsoft.com/Calendars.ReadWrite'
          : 'openid email profile offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/POP.AccessAsUser.All https://outlook.office.com/SMTP.Send',
      clientId: config.microsoft.clientId,
      clientSecret: config.microsoft.clientSecret,
      extraAuthParams: { prompt: 'select_account' },
      scopeOnRefresh: true,
    };
  }
  throw new HttpError(400, `Sign-in with ${id} is not configured on this server`);
}

export const oauthAvailable = () => ({ google: !!config.google, microsoft: !!config.microsoft });
export const redirectUri = (id: OAuthProviderId) => `${config.publicUrl}/api/oauth/${id}/callback`;

export interface PendingOAuth {
  userId: number;
  provider: OAuthProviderId;
  purpose: OAuthPurpose;
  verifier: string;
  /** Re-authorise an existing account instead of creating a new one. */
  accountId?: number;
  /** Re-authorise an existing calendar account. */
  sourceId?: number;
  protocol: 'imap' | 'pop3';
  displayName?: string;
  created: number;
}

const pending = new Map<string, PendingOAuth>();
setInterval(() => {
  for (const [k, v] of pending) if (Date.now() - v.created > 15 * 60_000) pending.delete(k);
}, 60_000).unref();

export function startOAuth(p: Omit<PendingOAuth, 'verifier' | 'created'>): string {
  const def = provider(p.provider, p.purpose);
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  pending.set(state, { ...p, verifier, created: Date.now() });
  const params = new URLSearchParams({
    client_id: def.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(p.provider),
    scope: def.scope,
    state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...def.extraAuthParams,
  });
  return `${def.authUrl}?${params}`;
}

export function takePending(state: string): PendingOAuth {
  const p = pending.get(state);
  pending.delete(state);
  if (!p) throw badRequest('This sign-in link expired. Please try again.');
  return p;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(def: ProviderDef, params: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams({ client_id: def.clientId, ...params });
  if (def.clientSecret) body.set('client_secret', def.clientSecret);
  const res = await fetch(def.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) throw new HttpError(502, `OAuth token request failed: ${json.error_description || json.error || res.status}`);
  return json;
}

export interface OAuthIdentity {
  email: string;
  name: string;
  secret: AccountSecret;
}

export async function finishOAuth(p: PendingOAuth, code: string): Promise<OAuthIdentity> {
  const def = provider(p.provider, p.purpose);
  const tok = await tokenRequest(def, {
    grant_type: 'authorization_code',
    code,
    code_verifier: p.verifier,
    redirect_uri: redirectUri(p.provider),
  });
  if (!tok.refresh_token) throw new HttpError(502, 'The provider did not return a refresh token; HomeMail could not stay signed in.');
  // The ID token came straight from the token endpoint over TLS, so its claims can be trusted without verifying the signature.
  const claims = tok.id_token ? JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8')) : {};
  const email: string = claims.email || claims.preferred_username || '';
  if (!email.includes('@')) throw new HttpError(502, 'Could not determine the email address of the signed-in account');
  return {
    email: email.toLowerCase(),
    name: claims.name || '',
    secret: { accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 },
  };
}

/** Exchanges a refresh token for a new access token (and, with Microsoft, a new refresh token). */
export async function refreshGrant(id: OAuthProviderId, purpose: OAuthPurpose, refreshToken: string): Promise<AccountSecret> {
  const def = provider(id, purpose);
  const params: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refreshToken };
  if (def.scopeOnRefresh) params.scope = def.scope;
  const tok = await tokenRequest(def, params).catch((err) => {
    throw new HttpError(401, `Sign-in expired, please reconnect this account (${err.message})`);
  });
  return { accessToken: tok.access_token, refreshToken: tok.refresh_token || refreshToken, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 };
}

const refreshing = new Map<number, Promise<string>>();

async function refreshAccessToken(account: AccountRow): Promise<string> {
  const secret = readSecret(account);
  if (!secret.refreshToken) throw new HttpError(401, 'This account needs to be signed in again');
  const tok = await refreshGrant(account.oauth_provider!, 'mail', secret.refreshToken);
  // Re-read in case something else updated the row meanwhile; Microsoft rotates refresh tokens.
  const fresh = readSecret(getAccountById(account.id) ?? account);
  writeSecret(account.id, { ...fresh, ...tok });
  return tok.accessToken!;
}

export interface ResolvedAuth {
  user: string;
  pass?: string;
  accessToken?: string;
}

/** Credentials for connecting, refreshing OAuth access tokens when needed. */
export async function resolveAuth(account: AccountRow, which: 'incoming' | 'smtp'): Promise<ResolvedAuth> {
  const user = which === 'incoming' ? account.in_username : account.smtp_username;
  const secret = readSecret(account);
  if (account.auth_type === 'password') {
    return { user, pass: which === 'smtp' ? secret.smtpPassword || secret.password : secret.password };
  }
  if (secret.accessToken && (secret.expiresAt ?? 0) > Date.now() + 120_000) return { user, accessToken: secret.accessToken };
  let p = refreshing.get(account.id);
  if (!p) {
    p = refreshAccessToken(account).finally(() => refreshing.delete(account.id));
    refreshing.set(account.id, p);
  }
  return { user, accessToken: await p };
}
