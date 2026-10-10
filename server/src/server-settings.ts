import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { getSetting, setSetting } from './db.js';
import type { Security } from './providers.js';

/**
 * Server-wide settings: environment variables give the defaults, and values an
 * admin saves in Settings → Server override them.
 */

export type MailMode = 'builtin' | 'stalwart' | 'external' | 'off';
export type OutboundMode = 'direct' | 'relay' | 'off';

export interface RelaySettings {
  host: string;
  port: number;
  security: Security;
  username: string;
  password?: string;
}

export interface ExternalServer {
  imap: { host: string; port: number; security: Security };
  smtp: { host: string; port: number; security: Security };
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
export const isValidDomain = (d: string) => DOMAIN_RE.test(d);

export function chatDomain(): string {
  return getSetting('chat_domain') || config.chatDomain || config.serverDomain;
}

export function mailDomain(): string {
  return getSetting('mail_domain') || config.mailDomain || config.serverDomain;
}

export function mailHostname(): string {
  return getSetting('mail_hostname') || config.mailHostname || `mail.${mailDomain()}`;
}

export function mailModesAvailable(): MailMode[] {
  return config.stalwart ? ['builtin', 'stalwart', 'external', 'off'] : ['builtin', 'external', 'off'];
}

export function mailMode(): MailMode {
  const saved = getSetting('mail_mode') as MailMode | undefined;
  const wanted = saved || (config.mailServerMode as MailMode | undefined) || 'builtin';
  // Stalwart can only be used when the container is configured.
  return mailModesAvailable().includes(wanted) ? wanted : 'builtin';
}

export function federationAvailable(): boolean {
  return !!config.xmpp;
}

export function federationEnabled(): boolean {
  if (!config.xmpp) return false;
  const saved = getSetting('chat_federation');
  return saved ? saved === 'true' : config.chatFederation;
}

export function outboundMode(): OutboundMode {
  return (getSetting('outbound_mode') as OutboundMode | undefined) || 'direct';
}

export function relaySettings(): RelaySettings | null {
  const raw = getSetting('relay');
  return raw ? decrypt<RelaySettings>(raw) : null;
}

export function externalServer(): ExternalServer | null {
  const raw = getSetting('external_server');
  return raw ? (JSON.parse(raw) as ExternalServer) : null;
}

export interface ServerSettingsUpdate {
  chatDomain?: string;
  mailDomain?: string;
  mailHostname?: string;
  mailMode?: MailMode;
  chatFederation?: boolean;
  outboundMode?: OutboundMode;
  /** Password left undefined keeps the stored one. */
  relay?: RelaySettings | null;
  externalServer?: ExternalServer | null;
}

export function saveServerSettings(u: ServerSettingsUpdate): void {
  if (u.chatDomain !== undefined) setSetting('chat_domain', u.chatDomain);
  if (u.mailDomain !== undefined) setSetting('mail_domain', u.mailDomain);
  if (u.mailHostname !== undefined) setSetting('mail_hostname', u.mailHostname);
  if (u.mailMode !== undefined) setSetting('mail_mode', u.mailMode);
  if (u.chatFederation !== undefined) setSetting('chat_federation', String(u.chatFederation));
  if (u.outboundMode !== undefined) setSetting('outbound_mode', u.outboundMode);
  if (u.relay !== undefined) {
    if (u.relay === null) setSetting('relay', '');
    else setSetting('relay', encrypt({ ...u.relay, password: u.relay.password ?? relaySettings()?.password }));
  }
  if (u.externalServer !== undefined) setSetting('external_server', u.externalServer ? JSON.stringify(u.externalServer) : '');
}

export function userAddress(username: string, domain = chatDomain()): string {
  return `${username.toLowerCase()}@${domain}`;
}
