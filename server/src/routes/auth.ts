import { Router } from 'express';
import { z } from 'zod';
import { db, getSetting, now, setSetting } from '../db.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import {
  type User,
  checkLoginRate,
  clearLoginRate,
  createSession,
  destroySession,
  publicUser,
  requireAdmin,
  requireUser,
} from '../auth.js';
import { HttpError, badRequest, notFound, parse } from '../http.js';
import { oauthAvailable } from '../oauth.js';
import { deleteAccount } from '../accounts.js';
import { closeImap } from '../mail/imap.js';

export const authRouter = Router();

const username = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-zA-Z0-9._@-]+$/, 'only letters, digits and . _ @ - are allowed');
const password = z.string().min(10, 'must be at least 10 characters').max(512);

const userCount = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
const registrationOpen = () => (getSetting('allow_registration') ?? String(config.allowRegistration)) === 'true';

authRouter.get('/auth/state', (req, res) => {
  res.json({
    user: req.user ? publicUser(req.user) : null,
    needsSetup: userCount() === 0,
    registrationOpen: registrationOpen(),
    oauth: oauthAvailable(),
  });
});

async function insertUser(input: { username: string; password: string; displayName?: string; isAdmin: boolean }): Promise<number> {
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(input.username);
  if (exists) throw new HttpError(409, 'That username is taken');
  const info = db
    .prepare('INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.username, input.displayName || input.username, await hashPassword(input.password), input.isAdmin ? 1 : 0, now());
  return Number(info.lastInsertRowid);
}

authRouter.post('/auth/register', async (req, res) => {
  const body = parse(z.object({ username, password, displayName: z.string().trim().max(100).optional() }), req.body);
  const first = userCount() === 0;
  if (!first && !registrationOpen()) throw new HttpError(403, 'Registration is closed. Ask an admin to create an account for you.');
  // The very first user becomes the administrator.
  const id = await insertUser({ ...body, isAdmin: first });
  createSession(res, req, id);
  res.json({ ok: true });
});

authRouter.post('/auth/login', async (req, res) => {
  const body = parse(z.object({ username: z.string().trim().max(64), password: z.string().max(512) }), req.body);
  const key = `${req.ip}|${body.username.toLowerCase()}`;
  checkLoginRate(key);
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(body.username) as (User & { password_hash: string }) | undefined;
  // Always run a hash comparison so timing doesn't reveal whether the user exists.
  const ok = await verifyPassword(body.password, row?.password_hash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  if (!row || !ok) throw new HttpError(401, 'Wrong username or password');
  if (row.disabled) throw new HttpError(403, 'This user is disabled');
  clearLoginRate(key);
  createSession(res, req, row.id);
  res.json({ ok: true });
});

authRouter.post('/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

authRouter.post('/auth/password', requireUser, async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string(), newPassword: password }), req.body);
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as { password_hash: string };
  if (!(await verifyPassword(body.currentPassword, row.password_hash))) throw new HttpError(403, 'Current password is wrong');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(body.newPassword), req.user!.id);
  res.json({ ok: true });
});

authRouter.patch('/auth/profile', requireUser, (req, res) => {
  const body = parse(z.object({ displayName: z.string().trim().min(1).max(100) }), req.body);
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(body.displayName, req.user!.id);
  res.json({ ok: true });
});

/* ---------- admin ---------- */

authRouter.get('/admin/users', requireUser, requireAdmin, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_admin, u.disabled, u.created_at,
        (SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id) AS accounts
       FROM users u ORDER BY u.id`,
    )
    .all() as (User & { accounts: number })[];
  res.json(
    rows.map((u) => ({ ...publicUser(u), disabled: !!u.disabled, createdAt: u.created_at, accountCount: u.accounts })),
  );
});

authRouter.post('/admin/users', requireUser, requireAdmin, async (req, res) => {
  const body = parse(
    z.object({ username, password, displayName: z.string().trim().max(100).optional(), isAdmin: z.boolean().default(false) }),
    req.body,
  );
  res.json({ id: await insertUser(body) });
});

const adminCount = () => (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0').get() as { n: number }).n;

authRouter.patch('/admin/users/:id', requireUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const body = parse(
    z.object({ isAdmin: z.boolean().optional(), disabled: z.boolean().optional(), password: password.optional(), displayName: z.string().trim().max(100).optional() }),
    req.body,
  );
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  if (!target) throw notFound('User not found');
  const losesAdmin = target.is_admin && !target.disabled && (body.isAdmin === false || body.disabled === true);
  if (losesAdmin && adminCount() <= 1) throw badRequest('There must be at least one active admin');
  if (body.isAdmin !== undefined) db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(body.isAdmin ? 1 : 0, id);
  if (body.displayName) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(body.displayName, id);
  if (body.disabled !== undefined) {
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, id);
    if (body.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (body.password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(body.password), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  res.json({ ok: true });
});

authRouter.delete('/admin/users/:id', requireUser, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user!.id) throw badRequest('You cannot delete yourself');
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  if (!target) throw notFound('User not found');
  if (target.is_admin && adminCount() <= 1) throw badRequest('There must be at least one active admin');
  const accountIds = db.prepare('SELECT id FROM accounts WHERE user_id = ?').pluck().all(id) as number[];
  for (const accountId of accountIds) {
    closeImap(accountId);
    deleteAccount(id, accountId);
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true, deletedAccounts: accountIds.length });
});

authRouter.get('/admin/settings', requireUser, requireAdmin, (_req, res) => {
  res.json({ registrationOpen: registrationOpen(), oauth: oauthAvailable(), publicUrl: config.publicUrl });
});

authRouter.put('/admin/settings', requireUser, requireAdmin, (req, res) => {
  const body = parse(z.object({ registrationOpen: z.boolean() }), req.body);
  setSetting('allow_registration', String(body.registrationOpen));
  res.json({ ok: true });
});
