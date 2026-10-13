import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { HttpError } from '../http.js';

export interface DavResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Final URL after redirects. */
  url: string;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  auth?: { user: string; pass: string };
  insecureTls?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Hosts in the same site, e.g. caldav.icloud.com and p52-caldav.icloud.com, may share credentials. */
const site = (host: string) => host.split('.').slice(-2).join('.');

/**
 * An HTTP request for CalDAV and calendar feeds. Unlike fetch, it can accept
 * self-signed certificates (common for Nextcloud or Radicale on a LAN) and it
 * keeps the method and credentials across the redirects DAV servers use.
 */
export async function request(url: string, opts: RequestOptions = {}): Promise<DavResponse> {
  let current = new URL(url);
  let auth = opts.auth;
  for (let hop = 0; hop < 6; hop++) {
    const res = await once(current, { ...opts, auth });
    const loc = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      const next = new URL(loc, current);
      if (next.protocol === 'http:' && current.protocol === 'https:') throw new HttpError(502, `Refusing to follow a redirect from HTTPS to HTTP (${next.origin})`);
      if (site(next.hostname) !== site(current.hostname)) auth = undefined;
      current = next;
      continue;
    }
    return { ...res, url: current.toString() };
  }
  throw new HttpError(502, 'Too many redirects');
}

function once(url: URL, opts: RequestOptions): Promise<Omit<DavResponse, 'url'>> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return Promise.reject(new HttpError(400, 'Only http(s) URLs are supported'));
  const headers: Record<string, string> = { 'user-agent': 'HomeMail', 'accept-encoding': 'gzip, deflate', ...opts.headers };
  if (opts.auth) headers.authorization = 'Basic ' + Buffer.from(`${opts.auth.user}:${opts.auth.pass}`).toString('base64');
  const body = opts.body !== undefined ? Buffer.from(opts.body, 'utf8') : undefined;
  if (body) headers['content-length'] = String(body.length);
  const lib = url.protocol === 'https:' ? https : http;
  const max = opts.maxBytes ?? 50 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      { method: opts.method ?? 'GET', headers, rejectUnauthorized: !opts.insecureTls, timeout: opts.timeoutMs ?? 30_000 },
      (res) => {
        const enc = res.headers['content-encoding'];
        const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (c: Buffer) => {
          size += c.length;
          if (size > max) {
            req.destroy();
            reject(new HttpError(502, 'The calendar server sent more data than HomeMail accepts'));
          } else chunks.push(c);
        });
        stream.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        stream.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

/** Turns a failed response into an error a person can act on. */
export function statusError(res: DavResponse, what: string): HttpError {
  if (res.status === 401) return new HttpError(502, `${what}: the server rejected the username or password (many providers need an app-specific password)`);
  if (res.status === 403) return new HttpError(502, `${what}: permission denied`);
  if (res.status === 404) return new HttpError(502, `${what}: not found at ${res.url}`);
  if (res.status === 412) return new HttpError(409, `${what}: it was changed elsewhere in the meantime. Refresh and try again.`);
  return new HttpError(502, `${what}: the server answered ${res.status}`);
}
