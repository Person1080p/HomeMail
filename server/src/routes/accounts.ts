import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { encrypt } from '../crypto.js';
import { requireUser } from '../auth.js';
import { HttpError, badRequest, describeMailError, parse } from '../http.js';
import {
  type AccountInput,
  type AccountRow,
  type AccountSecret,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  publicAccount,
  readSecret,
  setAccountStatus,
  updateAccount,
} from '../accounts.js';
import { PRESETS, autodetect, presetById } from '../providers.js';
import { finishOAuth, oauthAvailable, startOAuth, takePending, type OAuthProviderId } from '../oauth.js';
import { closeImap, testImap } from '../mail/imap.js';
import { connectOAuthCalendar } from '../calendar/service.js';
import { getSource } from '../calendar/store.js';
import { connectPop3 } from '../mail/local.js';
import { testSmtp } from '../mail/smtp.js';

export const accountsRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const email = z.string().trim().toLowerCase().regex(EMAIL_RE, 'not a valid email address');
const security = z.enum(['tls', 'starttls', 'none']);
const server = z.object({
  host: z.string().trim().min(1, 'host is required').max(255),
  port: z.coerce.number().int().min(1).max(65535),
  security,
  username: z.string().trim().max(320),
});

const accountBody = z.object({
  label: z.string().trim().max(100).optional(),
  provider: z.string().max(40).default('imap'),
  email,
  displayName: z.string().trim().max(200).default(''),
  protocol: z.enum(['imap', 'pop3']),
  incoming: server,
  smtp: server,
  password: z.string().max(2000).optional(),
  smtpPassword: z.string().max(2000).optional(),
  allowInsecureTls: z.boolean().default(false),
  leaveOnServer: z.boolean().default(true),
  saveSent: z.boolean().default(true),
  signature: z.string().max(20000).default(''),
});
type AccountBody = z.infer<typeof accountBody>;

function toInput(b: AccountBody, authType: 'password' | 'oauth2', oauthProvider: OAuthProviderId | null): AccountInput {
  return {
    label: b.label || b.email,
    provider: b.provider,
    email: b.email,
    display_name: b.displayName,
    protocol: b.protocol,
    in_host: b.incoming.host,
    in_port: b.incoming.port,
    in_security: b.incoming.security,
    in_username: b.incoming.username || b.email,
    smtp_host: b.smtp.host,
    smtp_port: b.smtp.port,
    smtp_security: b.smtp.security,
    smtp_username: b.smtp.username,
    auth_type: authType,
    oauth_provider: oauthProvider,
    allow_insecure_tls: b.allowInsecureTls ? 1 : 0,
    leave_on_server: b.leaveOnServer ? 1 : 0,
    save_sent: b.saveSent ? 1 : 0,
    signature: b.signature,
  };
}

function checkProvider(id: string) {
  const preset = presetById(id);
  if (!preset) throw badRequest('Unknown provider');
  if (!preset.supported) throw badRequest(preset.notes);
  return preset;
}

/** Builds an unsaved account row so connection tests can reuse the normal code paths. */
function draftRow(userId: number, input: AccountInput, secret: AccountSecret): AccountRow {
  return {
    ...input,
    id: -Date.now(),
    user_id: userId,
    secret: encrypt(secret),
    sort_order: 0,
    last_error: null,
    last_sync: null,
    created_at: Date.now(),
    managed: null,
  };
}

async function testAccount(account: AccountRow): Promise<{ incoming: string | null; smtp: string | null }> {
  if (account.protocol === 'local') return { incoming: null, smtp: null };
  const incoming = (async () => {
    if (account.protocol === 'imap') await testImap(account);
    else await (await connectPop3(account)).quit();
  })();
  const [inRes, smtpRes] = await Promise.allSettled([incoming, testSmtp(account)]);
  return {
    incoming: inRes.status === 'rejected' ? describeMailError(inRes.reason) : null,
    smtp: smtpRes.status === 'rejected' ? describeMailError(smtpRes.reason) : null,
  };
}

accountsRouter.get('/providers', requireUser, (_req, res) => {
  const oauth = oauthAvailable();
  res.json(
    PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      imap: p.imap ?? null,
      pop3: p.pop3 ?? null,
      smtp: p.smtp ?? null,
      authMethods: p.authMethods,
      oauthProvider: p.oauthProvider ?? null,
      oauthAvailable: p.oauthProvider ? oauth[p.oauthProvider] : false,
      allowInsecureTls: !!p.allowInsecureTls,
      supported: p.supported,
      notes: p.notes,
      helpUrl: p.helpUrl ?? null,
    })),
  );
});

accountsRouter.post('/autodetect', requireUser, async (req, res) => {
  const body = parse(z.object({ email }), req.body);
  res.json(await autodetect(body.email));
});

accountsRouter.get('/accounts', requireUser, (req, res) => {
  res.json(listAccounts(req.user!.id).map(publicAccount));
});

accountsRouter.post('/accounts/test', requireUser, async (req, res) => {
  const body = parse(accountBody, req.body);
  checkProvider(body.provider);
  const row = draftRow(req.user!.id, toInput(body, 'password', null), { password: body.password, smtpPassword: body.smtpPassword || undefined });
  res.json(await testAccount(row));
});

accountsRouter.post('/accounts', requireUser, async (req, res) => {
  const body = parse(accountBody, req.body);
  const preset = checkProvider(body.provider);
  if (!preset.authMethods.includes('password')) throw badRequest(`${preset.name} requires signing in with ${preset.oauthProvider}`);
  if (!body.password) throw badRequest('Password is required');
  const account = createAccount(req.user!.id, toInput(body, 'password', null), {
    password: body.password,
    smtpPassword: body.smtpPassword || undefined,
  });
  res.json(publicAccount(account));
});

accountsRouter.put('/accounts/:id', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  const existing = getAccount(req.user!.id, id);
  if (existing.managed) {
    // The server's own mailbox: only cosmetic fields are the user's to change.
    const body = parse(z.object({ label: z.string().trim().max(100).optional(), displayName: z.string().trim().max(200).default(''), signature: z.string().max(20000).default('') }), req.body);
    const updated = updateAccount(req.user!.id, id, { label: body.label || existing.email, display_name: body.displayName, signature: body.signature });
    return res.json(publicAccount(updated));
  }
  const body = parse(accountBody, req.body);
  checkProvider(body.provider);
  const input = toInput(body, existing.auth_type, existing.oauth_provider);
  let secret: AccountSecret | undefined;
  if (existing.auth_type === 'password' && (body.password || body.smtpPassword !== undefined)) {
    const old = readSecret(existing);
    secret = { password: body.password || old.password, smtpPassword: body.smtpPassword === undefined ? old.smtpPassword : body.smtpPassword || undefined };
  }
  if (existing.auth_type === 'oauth2') {
    // Identity and servers of OAuth accounts are tied to the provider; only cosmetic fields change.
    Object.assign(input, {
      email: existing.email,
      in_username: existing.in_username,
      smtp_username: existing.smtp_username,
    });
  }
  const updated = updateAccount(req.user!.id, id, input, secret);
  setAccountStatus(id, null);
  closeImap(id);
  res.json(publicAccount(updated));
});

accountsRouter.post('/accounts/:id/test', requireUser, async (req, res) => {
  const account = getAccount(req.user!.id, Number(req.params.id));
  const result = await testAccount(account);
  setAccountStatus(account.id, result.incoming || result.smtp);
  res.json(result);
});

accountsRouter.delete('/accounts/:id', requireUser, (req, res) => {
  const id = Number(req.params.id);
  if (getAccount(req.user!.id, id).managed) throw badRequest('This is your mailbox on this server and cannot be removed');
  closeImap(id);
  deleteAccount(req.user!.id, id);
  res.json({ ok: true });
});

accountsRouter.post('/accounts/reorder', requireUser, (req, res) => {
  const body = parse(z.object({ ids: z.array(z.number().int()).max(500) }), req.body);
  const stmt = db.prepare('UPDATE accounts SET sort_order = ? WHERE id = ? AND user_id = ?');
  db.transaction(() => body.ids.forEach((id, i) => stmt.run(i + 1, id, req.user!.id)))();
  res.json({ ok: true });
});

/* ---------- OAuth ---------- */

const providerParam = z.enum(['google', 'microsoft']);

accountsRouter.post('/oauth/:provider/start', requireUser, (req, res) => {
  const provider = parse(providerParam, req.params.provider);
  const body = parse(
    z.object({
      purpose: z.enum(['mail', 'calendar']).default('mail'),
      accountId: z.number().int().optional(),
      sourceId: z.number().int().optional(),
      protocol: z.enum(['imap', 'pop3']).default('imap'),
      displayName: z.string().trim().max(200).optional(),
    }),
    req.body ?? {},
  );
  if (body.accountId) getAccount(req.user!.id, body.accountId);
  if (body.sourceId && getSource(req.user!.id, body.sourceId).kind !== provider) throw badRequest('That calendar account is not a ' + provider + ' account');
  res.json({ url: startOAuth({ userId: req.user!.id, provider, ...body }) });
});

// The provider redirects the browser here; the SameSite=Lax session cookie comes along.
accountsRouter.get('/oauth/:provider/callback', async (req, res) => {
  let page = '/settings/accounts';
  const done = (params: Record<string, string>) => res.redirect(`/#${page}?${new URLSearchParams(params)}`);
  try {
    const q = parse(z.object({ state: z.string(), code: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() }), req.query);
    const pending = takePending(q.state);
    if (pending.purpose === 'calendar') page = '/settings/calendars';
    if (!req.user || req.user.id !== pending.userId) throw new HttpError(403, 'Signed-in user changed during authorisation');
    if (q.error || !q.code) throw badRequest(q.error_description || q.error || 'Authorisation was cancelled');
    const ident = await finishOAuth(pending, q.code);

    if (pending.purpose === 'calendar') return done({ oauth: connectOAuthCalendar(pending, ident) });

    if (pending.accountId) {
      const acc = getAccount(pending.userId, pending.accountId);
      if (acc.email.toLowerCase() !== ident.email) throw badRequest(`You signed in as ${ident.email}, but this account is ${acc.email}`);
      updateAccount(pending.userId, acc.id, {}, ident.secret);
      setAccountStatus(acc.id, null);
      closeImap(acc.id);
      return done({ oauth: 'reconnected', id: String(acc.id) });
    }

    const domain = ident.email.split('@')[1];
    const presetId =
      pending.provider === 'google'
        ? 'gmail'
        : (presetById('outlook')!.domains.some((d) => (typeof d === 'string' ? d === domain : d.test(domain))) ? 'outlook' : 'office365');
    const preset = presetById(presetId)!;
    const incoming = pending.protocol === 'pop3' && preset.pop3 ? preset.pop3 : preset.imap!;
    const account = createAccount(
      pending.userId,
      {
        label: ident.email,
        provider: presetId,
        email: ident.email,
        display_name: pending.displayName || ident.name,
        protocol: pending.protocol === 'pop3' && preset.pop3 ? 'pop3' : 'imap',
        in_host: incoming.host,
        in_port: incoming.port,
        in_security: incoming.security,
        in_username: ident.email,
        smtp_host: preset.smtp!.host,
        smtp_port: preset.smtp!.port,
        smtp_security: preset.smtp!.security,
        smtp_username: ident.email,
        auth_type: 'oauth2',
        oauth_provider: pending.provider,
        allow_insecure_tls: 0,
        leave_on_server: 1,
        save_sent: 1,
        signature: '',
      },
      ident.secret,
    );
    done({ oauth: 'added', id: String(account.id) });
  } catch (err) {
    done({ oauthError: err instanceof Error ? err.message : String(err) });
  }
});
