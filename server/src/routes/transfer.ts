import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requireUser } from '../auth.js';
import { verifyPassword } from '../crypto.js';
import { HttpError, badRequest, parse } from '../http.js';
import { type AccountInput, createAccount, listAccounts, publicAccount } from '../accounts.js';
import { presetById } from '../providers.js';
import { type ExportAccount, type ExportFile, toExportAccount } from '../export/common.js';
import { JSON_FORMAT, exportAutoconfig, exportJson, exportMobileconfig, exportSheet } from '../export/generic.js';
import { exportThunderbird, thunderbirdQrCodes } from '../export/thunderbird.js';
import { exportK9 } from '../export/k9.js';
import { accountsFromPrefs } from '../import/thunderbird.js';

export const transferRouter = Router();

type Exporter = (accounts: ExportAccount[]) => ExportFile | Promise<ExportFile>;

/** Keyed by the format id the frontend sends. */
export const EXPORTERS: Record<string, Exporter> = {
  thunderbird: exportThunderbird,
  k9: exportK9,
  autoconfig: exportAutoconfig,
  apple: exportMobileconfig,
  json: exportJson,
  sheet: exportSheet,
};

const exportBody = z.object({
  format: z.string(),
  accountIds: z.array(z.number().int()).default([]),
  includePasswords: z.boolean().default(false),
  currentPassword: z.string().max(512).optional(),
});

type Skipped = { label: string; reason: string }[];

async function selectAccounts(userId: number, body: z.infer<typeof exportBody>): Promise<{ accounts: ExportAccount[]; skipped: Skipped }> {
  if (body.includePasswords) {
    // Re-authenticate before handing out plaintext mail passwords.
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string };
    if (!body.currentPassword || !(await verifyPassword(body.currentPassword, row.password_hash))) {
      throw new HttpError(403, 'Enter your HomeMail password to include mail passwords in the export');
    }
  }
  const all = listAccounts(userId);
  const chosen = body.accountIds.length ? all.filter((a) => body.accountIds.includes(a.id)) : all;
  if (!chosen.length) throw badRequest('No accounts selected');
  // Built-in mailboxes live inside HomeMail; other apps have no way to reach them.
  const skipped = chosen
    .filter((a) => a.protocol === 'local')
    .map((a) => ({ label: a.label, reason: "HomeMail's built-in mail server has no IMAP access for other apps" }));
  const accounts = chosen.filter((a) => a.protocol !== 'local').map((a) => toExportAccount(a, body.includePasswords));
  if (!accounts.length) throw badRequest(skipped[0]?.reason ?? 'No accounts selected');
  return { accounts, skipped };
}

transferRouter.post('/export', requireUser, async (req, res) => {
  const body = parse(exportBody, req.body);
  const exporter = EXPORTERS[body.format];
  if (!exporter) throw badRequest('Unknown export format');
  const { accounts, skipped } = await selectAccounts(req.user!.id, body);
  const file = await exporter(accounts);
  res.setHeader('X-HomeMail-Skipped', encodeURIComponent(JSON.stringify([...skipped, ...file.skipped])));
  res.attachment(file.filename).type(file.contentType).send(file.body);
});

/** QR codes for Thunderbird for Android's "Import from Thunderbird desktop". */
transferRouter.post('/export/qr', requireUser, async (req, res) => {
  const body = parse(exportBody, req.body);
  const { accounts, skipped } = await selectAccounts(req.user!.id, body);
  const qr = await thunderbirdQrCodes(accounts);
  res.json({ ...qr, skipped: [...skipped, ...qr.skipped] });
});

/* ---------- import ---------- */

const importServer = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls', 'none']),
  username: z.string().max(320).default(''),
});
const importAccount = z.object({
  label: z.string().max(100).optional(),
  email: z.string().trim().toLowerCase().regex(/^[^\s@]+@[^\s@]+$/),
  displayName: z.string().max(200).default(''),
  provider: z.string().max(40).default('imap'),
  protocol: z.enum(['imap', 'pop3']),
  incoming: importServer,
  smtp: importServer,
  authType: z.enum(['password', 'oauth2']).default('password'),
  oauthProvider: z.enum(['google', 'microsoft']).nullable().default(null),
  password: z.string().max(2000).optional(),
  smtpPassword: z.string().max(2000).optional(),
  leaveOnServer: z.boolean().default(true),
  signature: z.string().max(20000).default(''),
  allowInsecureTls: z.boolean().default(false),
});
export type ImportAccount = z.infer<typeof importAccount>;

/** Creates accounts, skipping ones the user already has (same email + incoming server). */
export function importAccounts(userId: number, accounts: ImportAccount[]) {
  const existing = listAccounts(userId);
  const created = [];
  const skipped: { label: string; reason: string }[] = [];
  for (const a of accounts) {
    const label = a.label || a.email;
    if (existing.some((e) => e.email === a.email && e.in_host === a.incoming.host && e.protocol === a.protocol)) {
      skipped.push({ label, reason: 'already exists' });
      continue;
    }
    if (a.authType === 'oauth2' && !a.oauthProvider) {
      skipped.push({ label, reason: 'OAuth account without a known provider' });
      continue;
    }
    const preset = presetById(a.provider);
    if (preset && !preset.supported) {
      skipped.push({ label, reason: preset.notes });
      continue;
    }
    const input: AccountInput = {
      label,
      provider: preset ? a.provider : a.protocol,
      email: a.email,
      display_name: a.displayName,
      protocol: a.protocol,
      in_host: a.incoming.host,
      in_port: a.incoming.port,
      in_security: a.incoming.security,
      in_username: a.incoming.username || a.email,
      smtp_host: a.smtp.host,
      smtp_port: a.smtp.port,
      smtp_security: a.smtp.security,
      smtp_username: a.smtp.username,
      auth_type: a.authType,
      oauth_provider: a.authType === 'oauth2' ? a.oauthProvider : null,
      allow_insecure_tls: a.allowInsecureTls ? 1 : 0,
      leave_on_server: a.leaveOnServer ? 1 : 0,
      save_sent: 1,
      signature: a.signature,
    };
    created.push(publicAccount(createAccount(userId, input, { password: a.password, smtpPassword: a.smtpPassword })));
  }
  return { created, skipped };
}

transferRouter.post('/import/json', requireUser, (req, res) => {
  const doc = parse(
    z.object({ format: z.literal(JSON_FORMAT), version: z.literal(1), accounts: z.array(z.unknown()).max(500) }),
    req.body,
  );
  const accounts = doc.accounts.map((a, i) => {
    const r = importAccount.safeParse(a);
    if (!r.success) throw badRequest(`Account #${i + 1}: ${r.error.issues[0].path.join('.')} ${r.error.issues[0].message}`);
    return r.data;
  });
  res.json({ ...importAccounts(req.user!.id, accounts), notes: [] });
});

transferRouter.post('/import/thunderbird', requireUser, (req, res) => {
  const body = parse(z.object({ prefs: z.string().min(1).max(10_000_000) }), req.body);
  const { accounts, notes } = accountsFromPrefs(body.prefs);
  if (!accounts.length && !notes.length) throw badRequest('No mail accounts found. Make sure you picked prefs.js from your Thunderbird profile folder.');
  const result = importAccounts(req.user!.id, accounts);
  // Notes are warnings about accounts that were imported but need attention, or couldn't be.
  res.json({ ...result, notes });
});
