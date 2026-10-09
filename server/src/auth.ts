import type { NextFunction, Request, Response } from 'express';
import { db, now } from './db.js';
import { config } from './config.js';
import { randomToken, sha256 } from './crypto.js';
import { HttpError } from './http.js';

export interface User {
  id: number;
  username: string;
  display_name: string;
  is_admin: number;
  disabled: number;
  created_at: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export const SESSION_COOKIE = 'homemail_sid';

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function createSession(res: Response, req: Request, userId: number): void {
  const token = randomToken();
  const ts = now();
  const expires = ts + config.sessionDays * 86400_000;
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(sha256(token), userId, ts, expires, ts, (req.headers['user-agent'] || '').slice(0, 300));
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expires),
  });
}

export function destroySession(req: Request, res: Response): void {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Attaches req.user when a valid session cookie is present. Never rejects. */
export function loadUser(req: Request, _res: Response, next: NextFunction) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const hash = sha256(token);
    const row = db
      .prepare(
        `SELECT s.expires_at, s.last_seen, u.id, u.username, u.display_name, u.is_admin, u.disabled, u.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(hash) as (User & { expires_at: number; last_seen: number }) | undefined;
    if (row && row.expires_at > now() && !row.disabled) {
      const { expires_at: _e, last_seen, ...user } = row;
      req.user = user;
      if (now() - last_seen > 300_000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), hash);
    }
  }
  next();
}

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Not signed in'));
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.is_admin) return next(new HttpError(403, 'Admin only'));
  next();
}

/**
 * CSRF protection: state-changing API calls must carry a custom header, which
 * cross-site forms cannot set and cross-origin fetches cannot send without CORS.
 */
export function requireCsrfHeader(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-homemail') !== '1') return next(new HttpError(403, 'Missing X-HomeMail header'));
  next();
}

export function publicUser(u: User) {
  return { id: u.id, username: u.username, displayName: u.display_name, isAdmin: !!u.is_admin };
}

/** Tiny fixed-window limiter for login attempts, keyed by IP + username. */
const attempts = new Map<string, { count: number; reset: number }>();
export function checkLoginRate(key: string): void {
  const t = now();
  const entry = attempts.get(key);
  if (!entry || entry.reset < t) {
    attempts.set(key, { count: 1, reset: t + 15 * 60_000 });
    return;
  }
  entry.count++;
  if (entry.count > 10) throw new HttpError(429, 'Too many login attempts. Try again in a few minutes.');
}
export function clearLoginRate(key: string): void {
  attempts.delete(key);
}
setInterval(() => {
  const t = now();
  for (const [k, v] of attempts) if (v.reset < t) attempts.delete(k);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
}, 10 * 60_000).unref();
