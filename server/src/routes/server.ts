import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { requireAdmin, requireUser } from '../auth.js';
import { badRequest, parse } from '../http.js';
import { db } from '../db.js';
import {
  chatDomain,
  externalServer,
  federationAvailable,
  federationEnabled,
  isValidDomain,
  mailDomain,
  mailHostname,
  mailMode,
  mailModesAvailable,
  outboundMode,
  relaySettings,
  saveServerSettings,
  userAddress,
} from '../server-settings.js';
import { startXmpp, xmppStatus } from '../chat/xmpp.js';
import { builtinDnsRecords, builtinSmtpStatus, deleteQueueEntry, queueEntries, retryQueueEntry, startBuiltinSmtp } from '../mailserver/builtin.js';
import { stalwartStatus } from '../mailserver/stalwart.js';
import { mailboxInfo, provisionErrors, resetMailboxPassword, syncAllMailboxes } from '../mailserver/provision.js';

export const serverRouter = Router();

/* ---------- the signed-in user's own address and mailbox ---------- */

serverRouter.get('/me/addresses', requireUser, (req, res) => {
  res.json({
    chat: { address: userAddress(req.user!.username), federation: federationEnabled() },
    mailbox: mailboxInfo(req.user!.id),
  });
});

serverRouter.post('/me/mailbox-password', requireUser, async (req, res) => {
  res.json({ password: await resetMailboxPassword(req.user!.id) });
});

/* ---------- admin ---------- */

async function serverState() {
  const mode = mailMode();
  const sw = mode === 'stalwart' ? await stalwartStatus() : null;
  const relay = relaySettings();
  const users = db.prepare('SELECT id, username FROM users').all() as { id: number; username: string }[];
  return {
    chatDomain: chatDomain(),
    mailDomain: mailDomain(),
    mailHostname: mailHostname(),
    mailMode: mode,
    mailModes: mailModesAvailable(),
    chatFederation: federationEnabled(),
    federationAvailable: federationAvailable(),
    xmpp: federationAvailable() ? xmppStatus() : null,
    outboundMode: outboundMode(),
    relay: relay ? { ...relay, password: undefined, hasPassword: !!relay.password } : null,
    externalServer: externalServer(),
    builtin: mode === 'builtin' ? { smtp: builtinSmtpStatus(), queue: queueEntries(), dns: builtinDnsRecords() } : null,
    stalwart: config.stalwart ? { configured: true, ...(sw ?? { ok: null, error: null, dnsZone: null }) } : { configured: false },
    provisionErrors: users.filter((u) => provisionErrors.has(u.id)).map((u) => ({ username: u.username, error: provisionErrors.get(u.id)! })),
  };
}

serverRouter.get('/admin/server', requireUser, requireAdmin, async (_req, res) => {
  res.json(await serverState());
});

const security = z.enum(['tls', 'starttls', 'none']);
const hostPort = z.object({ host: z.string().trim().min(1).max(255), port: z.number().int().min(1).max(65535), security });
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isValidDomain, 'not a valid domain name');

serverRouter.put('/admin/server', requireUser, requireAdmin, async (req, res) => {
  const body = parse(
    z.object({
      chatDomain: domain.optional(),
      mailDomain: domain.optional(),
      mailHostname: domain.optional(),
      mailMode: z.enum(['builtin', 'stalwart', 'external', 'off']).optional(),
      chatFederation: z.boolean().optional(),
      outboundMode: z.enum(['direct', 'relay', 'off']).optional(),
      relay: hostPort.extend({ username: z.string().max(320).default(''), password: z.string().max(2000).optional() }).nullable().optional(),
      externalServer: z.object({ imap: hostPort, smtp: hostPort }).nullable().optional(),
    }),
    req.body,
  );
  if (body.mailMode && !mailModesAvailable().includes(body.mailMode)) throw badRequest('That mail server mode is not available on this installation');
  if (body.chatFederation && !federationAvailable()) throw badRequest('Federation needs an XMPP server (XMPP_COMPONENT_SERVICE)');
  const before = { chat: chatDomain(), fed: federationEnabled(), mail: mailDomain(), mode: mailMode(), host: mailHostname() };
  saveServerSettings({ ...body, relay: body.relay === undefined ? undefined : body.relay });

  // Apply what changed.
  if (before.chat !== chatDomain() || before.fed !== federationEnabled()) await startXmpp();
  if (before.mode !== mailMode() || before.mail !== mailDomain() || before.host !== mailHostname()) {
    await startBuiltinSmtp();
    await syncAllMailboxes();
  }
  res.json(await serverState());
});

serverRouter.post('/admin/server/provision', requireUser, requireAdmin, async (_req, res) => {
  await syncAllMailboxes();
  res.json(await serverState());
});

serverRouter.post('/admin/server/queue/:id/retry', requireUser, requireAdmin, (req, res) => {
  retryQueueEntry(Number(req.params.id));
  res.json({ ok: true });
});

serverRouter.delete('/admin/server/queue/:id', requireUser, requireAdmin, (req, res) => {
  deleteQueueEntry(Number(req.params.id));
  res.json({ ok: true });
});
