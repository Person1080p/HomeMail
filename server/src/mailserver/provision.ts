import crypto from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import { badRequest } from '../http.js';
import { type AccountInput, type AccountRow, createAccount, updateAccount } from '../accounts.js';
import { closeImap } from '../mail/imap.js';
import { mailDomain, mailHostname, mailMode } from '../server-settings.js';
import { deleteStalwartUser, upsertStalwartUser } from './stalwart.js';

/*
 * Gives every HomeMail user a mailbox on the server's own mail domain, in whichever
 * mail-server mode is active, and shows it as an account in their mail view.
 */

interface UserRow {
  id: number;
  username: string;
  display_name: string;
}

const MAILBOX_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Last provisioning error per user, shown on the admin page. */
export const provisionErrors = new Map<number, string>();

const managedAccount = (userId: number, kind: 'builtin' | 'stalwart') =>
  db.prepare('SELECT * FROM accounts WHERE user_id = ? AND managed = ?').get(userId, kind) as AccountRow | undefined;

const generatePassword = () => crypto.randomBytes(18).toString('base64url');

function builtinInput(user: UserRow, email: string): AccountInput {
  return {
    label: email,
    provider: 'homemail',
    email,
    display_name: user.display_name || user.username,
    protocol: 'local',
    in_host: '',
    in_port: 0,
    in_security: 'none',
    in_username: user.username,
    smtp_host: '',
    smtp_port: 0,
    smtp_security: 'none',
    smtp_username: '',
    auth_type: 'password',
    oauth_provider: null,
    allow_insecure_tls: 0,
    leave_on_server: 1,
    save_sent: 1,
    signature: '',
  };
}

function stalwartInput(user: UserRow, email: string): AccountInput {
  const sw = config.stalwart!;
  return {
    ...builtinInput(user, email),
    protocol: 'imap',
    in_host: sw.imapHost,
    in_port: sw.imapPort,
    in_security: 'tls',
    in_username: email,
    smtp_host: sw.imapHost,
    smtp_port: sw.smtpPort,
    smtp_security: 'tls',
    smtp_username: email,
    // Inside the Docker network Stalwart uses its own self-signed certificate.
    allow_insecure_tls: 1,
  };
}

export async function ensureMailbox(user: UserRow): Promise<void> {
  const mode = mailMode();
  if (mode !== 'builtin' && mode !== 'stalwart') return;
  const name = user.username.toLowerCase();
  if (!MAILBOX_NAME.test(name)) {
    provisionErrors.set(user.id, `"${user.username}" can't be used as a mailbox name (letters, digits, . _ - only)`);
    return;
  }
  const email = `${name}@${mailDomain()}`;
  try {
    if (mode === 'builtin') {
      const existing = managedAccount(user.id, 'builtin');
      if (!existing) createAccount(user.id, builtinInput(user, email), {}, 'builtin');
      else if (existing.email !== email) updateAccount(user.id, existing.id, { email, label: email });
    } else {
      const existing = managedAccount(user.id, 'stalwart');
      if (existing && existing.email === existing.in_username && existing.email === email) {
        provisionErrors.delete(user.id);
        return;
      }
      const password = generatePassword();
      await upsertStalwartUser(name, password, user.display_name || user.username);
      if (existing) {
        updateAccount(user.id, existing.id, stalwartInput(user, email), { password });
        closeImap(existing.id);
      } else {
        createAccount(user.id, stalwartInput(user, email), { password }, 'stalwart');
      }
    }
    provisionErrors.delete(user.id);
  } catch (err) {
    provisionErrors.set(user.id, (err as Error).message);
    console.warn(`[mailserver] could not set up a mailbox for ${user.username}: ${(err as Error).message}`);
  }
}

export async function ensureMailboxForUserId(userId: number): Promise<void> {
  const user = db.prepare('SELECT id, username, display_name FROM users WHERE id = ? AND disabled = 0').get(userId) as UserRow | undefined;
  if (user) await ensureMailbox(user);
}

export async function syncAllMailboxes(): Promise<void> {
  const users = db.prepare('SELECT id, username, display_name FROM users WHERE disabled = 0').all() as UserRow[];
  for (const u of users) await ensureMailbox(u);
}

/** Called before a user is deleted. Built-in mailboxes go with the account rows. */
export async function removeMailbox(username: string): Promise<void> {
  if (config.stalwart && mailMode() === 'stalwart') await deleteStalwartUser(username.toLowerCase()).catch(() => {});
}

/** New password for using the Stalwart mailbox in other apps; HomeMail switches to it too. */
export async function resetMailboxPassword(userId: number): Promise<string> {
  const acc = managedAccount(userId, 'stalwart');
  if (!acc || mailMode() !== 'stalwart') throw badRequest('Your mailbox on this server cannot be used from other apps');
  const user = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(userId) as UserRow;
  const password = generatePassword();
  await upsertStalwartUser(user.username.toLowerCase(), password, user.display_name || user.username);
  updateAccount(userId, acc.id, {}, { password });
  closeImap(acc.id);
  return password;
}

/** What the user needs to know about their own address and mailbox. */
export function mailboxInfo(userId: number) {
  const mode = mailMode();
  const builtin = managedAccount(userId, 'builtin');
  const stalwart = managedAccount(userId, 'stalwart');
  const acc = mode === 'stalwart' ? stalwart : mode === 'builtin' ? builtin : undefined;
  return {
    mode,
    address: acc?.email ?? null,
    accountId: acc?.id ?? null,
    error: provisionErrors.get(userId) ?? null,
    // Settings for Thunderbird, phones etc. Only Stalwart offers IMAP to other clients.
    clients:
      mode === 'stalwart' && acc
        ? {
            imap: { host: mailHostname(), port: 993, security: 'tls' as const },
            smtp: { host: mailHostname(), port: 465, security: 'tls' as const },
            username: acc.email,
          }
        : null,
  };
}

