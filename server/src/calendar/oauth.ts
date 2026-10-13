import { HttpError } from '../http.js';
import { refreshGrant } from '../oauth.js';
import { getSourceById, readSourceSecret, writeSourceSecret, type SourceRow } from './store.js';

const refreshing = new Map<number, Promise<string>>();

/** A current access token for a Google or Microsoft calendar account. */
export async function accessToken(source: SourceRow): Promise<string> {
  const secret = readSourceSecret(source);
  if (secret.accessToken && (secret.expiresAt ?? 0) > Date.now() + 120_000) return secret.accessToken;
  if (!secret.refreshToken) throw new HttpError(502, 'This calendar account needs to be signed in again');
  let p = refreshing.get(source.id);
  if (!p) {
    p = (async () => {
      const tok = await refreshGrant(source.kind as 'google' | 'microsoft', 'calendar', secret.refreshToken!).catch((err) => {
        // 401 would make the browser think its own session ended.
        throw new HttpError(502, err.message);
      });
      const fresh = readSourceSecret(getSourceById(source.id) ?? source);
      writeSourceSecret(source.id, { ...fresh, ...tok });
      return tok.accessToken!;
    })().finally(() => refreshing.delete(source.id));
    refreshing.set(source.id, p);
  }
  return p;
}

/** JSON request to a provider API with the account's token. */
export async function apiRequest<T>(
  source: SourceRow,
  name: string,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken(source)}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as { error?: { message?: string } | string; error_description?: string } | null;
  if (!res.ok) {
    const msg = typeof json?.error === 'object' ? json.error.message : json?.error_description || json?.error || res.statusText;
    const status = res.status === 404 ? 404 : res.status === 409 || res.status === 412 ? 409 : res.status === 410 ? 410 : 502;
    throw new HttpError(status, `${name}: ${msg || res.status}`);
  }
  return json as T;
}
