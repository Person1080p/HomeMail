import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { SMTPServer, type SMTPServerAddress } from 'smtp-server';
import { config } from '../config.js';
import { db, getSetting, now, setSetting } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import { HttpError, badRequest, describeMailError } from '../http.js';
import { type AccountRow } from '../accounts.js';
import { storeLocal } from '../mail/local.js';
import { publish } from '../events.js';
import { withTimeout } from '../util.js';
import { mailDomain, mailHostname, mailMode, outboundMode, relaySettings } from '../server-settings.js';

/*
 * HomeMail's minimal built-in mail server, the default for non-Docker installs.
 * - Mail between users on the mail domain is delivered straight into their mailboxes.
 * - Inbound SMTP accepts mail for existing users on the mail domain only (never relays).
 * - Mail to other domains goes through a retrying queue, directly to the recipient's
 *   MX or through a relay ("smarthost"), DKIM-signed.
 * Mailboxes live in HomeMail's local store; there is no IMAP access for other clients.
 */

const queueDir = path.join(config.dataDir, 'queue');
fs.mkdirSync(queueDir, { recursive: true });

const splitAddress = (addr: string) => {
  const a = addr.trim().toLowerCase();
  const at = a.lastIndexOf('@');
  return { local: a.slice(0, at), domain: a.slice(at + 1) };
};

/* ---------- mailboxes ---------- */

export function builtinAccountFor(username: string): AccountRow | undefined {
  return db
    .prepare("SELECT a.* FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.username = ? AND u.disabled = 0 AND a.managed = 'builtin'")
    .get(username) as AccountRow | undefined;
}

function isLocalRecipient(address: string): AccountRow | undefined {
  const { local, domain } = splitAddress(address);
  if (domain !== mailDomain()) return undefined;
  return builtinAccountFor(local);
}

async function deliverLocal(account: AccountRow, raw: Buffer) {
  await storeLocal(account.id, 'INBOX', raw);
  publish(account.user_id, 'mail.new', { accountId: account.id, folder: 'INBOX' });
}

/* ---------- DKIM ---------- */

interface DkimKey {
  selector: string;
  privateKey: string;
  publicKey: string;
}

export function dkimKey(domain = mailDomain()): DkimKey {
  const stored = getSetting(`dkim:${domain}`);
  if (stored) return decrypt<DkimKey>(stored);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key: DkimKey = {
    selector: 'homemail',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
  setSetting(`dkim:${domain}`, encrypt(key));
  return key;
}

/** DNS records the admin must publish for mail to and from other servers to work. */
export function builtinDnsRecords(): { type: string; name: string; value: string; note: string }[] {
  const domain = mailDomain();
  const host = mailHostname();
  const key = dkimKey(domain);
  const relay = outboundMode() === 'relay' ? relaySettings() : null;
  return [
    { type: 'A / AAAA', name: host, value: '<your public IP>', note: 'The mail host. Port 25 must reach HomeMail\'s SMTP port.' },
    { type: 'MX', name: domain, value: `10 ${host}.`, note: 'Where other servers deliver mail for your domain.' },
    {
      type: 'TXT',
      name: domain,
      value: relay ? `v=spf1 mx include:<your relay's SPF domain> -all` : 'v=spf1 mx -all',
      note: 'SPF: which servers may send mail for your domain.',
    },
    { type: 'TXT', name: `${key.selector}._domainkey.${domain}`, value: `v=DKIM1; k=rsa; p=${key.publicKey}`, note: 'DKIM: lets receivers verify HomeMail\'s signature.' },
    { type: 'TXT', name: `_dmarc.${domain}`, value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, note: 'DMARC policy.' },
    { type: 'PTR', name: '<your public IP>', value: host, note: 'Reverse DNS, set at your ISP or VPS provider. Many receivers require it.' },
  ];
}

/* ---------- sending ---------- */

/** Called for mail sent from a built-in mailbox. Local recipients get it immediately; others are queued. */
export async function submitFromBuiltin(account: AccountRow, raw: Buffer, recipients: string[]): Promise<void> {
  if (mailMode() !== 'builtin') throw new HttpError(503, 'The built-in mail server is turned off, so this mailbox cannot send.');
  const local: AccountRow[] = [];
  const external: string[] = [];
  for (const rcpt of recipients) {
    const target = isLocalRecipient(rcpt);
    if (target) local.push(target);
    else if (splitAddress(rcpt).domain === mailDomain()) throw badRequest(`There is no mailbox for ${rcpt} on this server`);
    else external.push(rcpt);
  }
  if (external.length && outboundMode() === 'off') {
    throw badRequest(`Sending to other domains is turned off on this server (${external.join(', ')})`);
  }
  for (const target of local) await deliverLocal(target, raw);
  for (const rcpt of external) enqueue(account.user_id, account.email, rcpt, raw);
  if (external.length) processQueue().catch(() => {});
}

function enqueue(userId: number, from: string, rcpt: string, raw: Buffer) {
  const file = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.eml`;
  fs.writeFileSync(path.join(queueDir, file), raw);
  db.prepare('INSERT INTO outbound_queue (user_id, mail_from, rcpt_to, file, next_attempt, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    userId,
    from,
    rcpt,
    file,
    now(),
    now(),
  );
}

interface QueueRow {
  id: number;
  user_id: number | null;
  mail_from: string;
  rcpt_to: string;
  file: string;
  attempts: number;
  next_attempt: number;
  last_error: string | null;
  created_at: number;
}

const RETRY_MINUTES = [1, 5, 15, 30, 60, 120, 240, 480, 720];
const GIVE_UP_AFTER = 3 * 86400_000;

function dkimOptions() {
  const domain = mailDomain();
  const key = dkimKey(domain);
  return { domainName: domain, keySelector: key.selector, privateKey: key.privateKey };
}

async function deliverRemote(row: QueueRow, raw: Buffer): Promise<void> {
  const envelope = { from: row.mail_from, to: [row.rcpt_to] };
  if (outboundMode() === 'relay') {
    const r = relaySettings();
    if (!r?.host) throw Object.assign(new Error('No relay server is configured'), { temporary: true });
    const t = nodemailer.createTransport({
      host: r.host,
      port: r.port,
      secure: r.security === 'tls',
      requireTLS: r.security === 'starttls',
      ignoreTLS: r.security === 'none',
      auth: r.username ? { user: r.username, pass: r.password ?? '' } : undefined,
      name: mailHostname(),
      dkim: dkimOptions(),
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 120_000,
    });
    try {
      await withTimeout(t.sendMail({ envelope, raw }), 180_000, 'Relay delivery');
    } finally {
      t.close();
    }
    return;
  }
  // Direct delivery: try each MX host in priority order.
  const domain = splitAddress(row.rcpt_to).domain;
  let hosts: string[];
  try {
    hosts = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') hosts = [domain]; // RFC 5321: fall back to the A record
    else throw err;
  }
  if (hosts.length === 1 && hosts[0] === '') throw Object.assign(new Error(`${domain} does not accept mail (null MX)`), { responseCode: 556 });
  let lastErr: unknown;
  for (const host of hosts) {
    const t = nodemailer.createTransport({
      host,
      port: 25,
      secure: false,
      // Use STARTTLS when offered; many MX hosts have certificates for other names.
      tls: { rejectUnauthorized: false },
      name: mailHostname(),
      dkim: dkimOptions(),
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 120_000,
    });
    try {
      await withTimeout(t.sendMail({ envelope, raw }), 180_000, `Delivery to ${host}`);
      return;
    } catch (err) {
      lastErr = err;
      // A 5xx answer is final; don't try lower-priority hosts.
      if (((err as { responseCode?: number }).responseCode ?? 0) >= 500) throw err;
    } finally {
      t.close();
    }
  }
  throw lastErr;
}

async function bounce(row: QueueRow, raw: Buffer, reason: string) {
  const sender = isLocalRecipient(row.mail_from);
  if (!sender) return;
  const subject = /^Subject:\s*(.*)$/im.exec(raw.subarray(0, 16_384).toString('utf8'))?.[1]?.trim() || '(no subject)';
  const dsn = await new MailComposer({
    from: { name: 'Mail Delivery System', address: `mailer-daemon@${mailDomain()}` },
    to: row.mail_from,
    subject: `Undelivered Mail Returned to Sender: ${subject}`,
    text: `Your message could not be delivered to ${row.rcpt_to}.\n\nReason: ${reason}\n\nThe original message is attached.\n`,
    attachments: [{ filename: 'original.eml', contentType: 'message/rfc822', content: raw }],
    headers: { 'Auto-Submitted': 'auto-replied' },
  })
    .compile()
    .build();
  await deliverLocal(sender, dsn);
}

let processing = false;

export async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    const due = db.prepare('SELECT * FROM outbound_queue WHERE next_attempt <= ? ORDER BY next_attempt LIMIT 50').all(now()) as QueueRow[];
    for (const row of due) {
      const file = path.join(queueDir, row.file);
      let raw: Buffer;
      try {
        raw = fs.readFileSync(file);
      } catch {
        db.prepare('DELETE FROM outbound_queue WHERE id = ?').run(row.id);
        continue;
      }
      const done = () => {
        db.prepare('DELETE FROM outbound_queue WHERE id = ?').run(row.id);
        fs.rmSync(file, { force: true });
      };
      try {
        if (outboundMode() === 'off') throw Object.assign(new Error('Sending to other domains is turned off'), { responseCode: 550 });
        await deliverRemote(row, raw);
        done();
      } catch (err) {
        const reason = describeMailError(err);
        const permanent = ((err as { responseCode?: number }).responseCode ?? 0) >= 500;
        if (permanent || now() - row.created_at > GIVE_UP_AFTER) {
          await bounce(row, raw, reason).catch((e) => console.warn('[mailserver] bounce failed:', e.message));
          done();
        } else {
          const wait = RETRY_MINUTES[Math.min(row.attempts, RETRY_MINUTES.length - 1)];
          db.prepare('UPDATE outbound_queue SET attempts = attempts + 1, next_attempt = ?, last_error = ? WHERE id = ?').run(now() + wait * 60_000, reason, row.id);
        }
      }
    }
  } finally {
    processing = false;
  }
}

export function queueEntries() {
  return (db.prepare('SELECT id, mail_from, rcpt_to, attempts, next_attempt, last_error, created_at FROM outbound_queue ORDER BY created_at').all() as Omit<QueueRow, 'file' | 'user_id'>[]).map(
    (r) => ({ id: r.id, from: r.mail_from, to: r.rcpt_to, attempts: r.attempts, nextAttempt: r.next_attempt, lastError: r.last_error, createdAt: r.created_at }),
  );
}

export function retryQueueEntry(id: number) {
  db.prepare('UPDATE outbound_queue SET next_attempt = ? WHERE id = ?').run(now(), id);
  processQueue().catch(() => {});
}

export function deleteQueueEntry(id: number) {
  const row = db.prepare('SELECT file FROM outbound_queue WHERE id = ?').get(id) as { file: string } | undefined;
  if (!row) return;
  db.prepare('DELETE FROM outbound_queue WHERE id = ?').run(id);
  fs.rmSync(path.join(queueDir, row.file), { force: true });
}

setInterval(() => {
  if (mailMode() === 'builtin') processQueue().catch((e) => console.warn('[mailserver] queue:', e.message));
}, 30_000).unref();

/* ---------- inbound SMTP ---------- */

let smtpServer: SMTPServer | null = null;
let smtpStatus: { listening: boolean; port: number; error: string | null } = { listening: false, port: config.builtinSmtp.port, error: null };
export const builtinSmtpStatus = () => smtpStatus;

export async function stopBuiltinSmtp() {
  const s = smtpServer;
  smtpServer = null;
  smtpStatus = { ...smtpStatus, listening: false };
  if (s) await new Promise<void>((r) => s.close(() => r()));
}

export async function startBuiltinSmtp(): Promise<void> {
  await stopBuiltinSmtp();
  if (mailMode() !== 'builtin' || config.builtinSmtp.port <= 0) return;
  const { tlsCert, tlsKey, maxMessageMb } = config.builtinSmtp;
  const hasTls = !!(tlsCert && tlsKey);
  const maxBytes = maxMessageMb * 1024 * 1024;
  const server = new SMTPServer({
    name: mailHostname(),
    banner: 'HomeMail',
    size: maxBytes,
    authOptional: true,
    disabledCommands: hasTls ? ['AUTH'] : ['AUTH', 'STARTTLS'],
    key: hasTls ? fs.readFileSync(tlsKey!) : undefined,
    cert: hasTls ? fs.readFileSync(tlsCert!) : undefined,
    logger: false,
    onRcptTo(address: SMTPServerAddress, _session, callback) {
      // Only ever accept mail for our own users; anything else would make us an open relay.
      if (!isLocalRecipient(address.address)) {
        return callback(Object.assign(new Error('5.1.1 No such user here'), { responseCode: 550 }));
      }
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= maxBytes) chunks.push(c);
      });
      stream.on('end', async () => {
        if ((stream as unknown as { sizeExceeded?: boolean }).sizeExceeded || size > maxBytes) {
          return callback(Object.assign(new Error('5.3.4 Message too big'), { responseCode: 552 }));
        }
        const received =
          `Received: from ${session.hostNameAppearsAs || 'unknown'} (${session.clientHostname || 'unknown'} [${session.remoteAddress}])\r\n` +
          `\tby ${mailHostname()} (HomeMail) with ${session.transmissionType || 'ESMTP'};\r\n\t${new Date().toUTCString()}\r\n`;
        const raw = Buffer.concat([Buffer.from(received), ...chunks]);
        try {
          for (const rcpt of session.envelope.rcptTo) {
            const target = isLocalRecipient(rcpt.address);
            if (target) await deliverLocal(target, raw);
          }
          callback();
        } catch (err) {
          console.warn('[mailserver] local delivery failed:', (err as Error).message);
          callback(Object.assign(new Error('4.3.0 Temporary local delivery failure'), { responseCode: 451 }));
        }
      });
    },
  });
  server.on('error', (err) => {
    smtpStatus = { ...smtpStatus, error: err.message };
    console.warn(`[mailserver] SMTP: ${err.message}`);
  });
  smtpServer = server;
  await new Promise<void>((resolve) => {
    server.listen(config.builtinSmtp.port, config.builtinSmtp.host, () => {
      smtpStatus = { listening: true, port: config.builtinSmtp.port, error: null };
      console.log(`[mailserver] built-in SMTP listening on ${config.builtinSmtp.host}:${config.builtinSmtp.port} for @${mailDomain()}`);
      resolve();
    });
    server.server.once('error', (err: Error) => {
      smtpStatus = { listening: false, port: config.builtinSmtp.port, error: err.message };
      resolve();
    });
  });
}
