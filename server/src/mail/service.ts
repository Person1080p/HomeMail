import type { AccountRow } from '../accounts.js';
import { ImapBackend } from './imap.js';
import { LocalBackend } from './local.js';
import type { MailBackend } from './types.js';

export function backendFor(account: AccountRow): MailBackend {
  return account.protocol === 'imap' ? new ImapBackend(account) : new LocalBackend(account);
}
