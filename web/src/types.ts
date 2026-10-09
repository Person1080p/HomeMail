export type Security = 'tls' | 'starttls' | 'none';

export interface User {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

export interface AuthState {
  user: User | null;
  needsSetup: boolean;
  registrationOpen: boolean;
  oauth: { google: boolean; microsoft: boolean };
}

export interface ServerSettings {
  host: string;
  port: number;
  security: Security;
}

export interface Account {
  id: number;
  label: string;
  provider: string;
  email: string;
  displayName: string;
  protocol: 'imap' | 'pop3';
  incoming: ServerSettings & { username: string };
  smtp: ServerSettings & { username: string };
  authType: 'password' | 'oauth2';
  oauthProvider: 'google' | 'microsoft' | null;
  hasPassword: boolean;
  hasSeparateSmtpPassword: boolean;
  oauthConnected: boolean;
  allowInsecureTls: boolean;
  leaveOnServer: boolean;
  saveSent: boolean;
  signature: string;
  sortOrder: number;
  lastError: string | null;
  lastSync: number | null;
}

export interface Provider {
  id: string;
  name: string;
  imap: ServerSettings | null;
  pop3: ServerSettings | null;
  smtp: ServerSettings | null;
  authMethods: ('password' | 'oauth2')[];
  oauthProvider: 'google' | 'microsoft' | null;
  oauthAvailable: boolean;
  allowInsecureTls: boolean;
  supported: boolean;
  notes: string;
  helpUrl: string | null;
}

export interface DetectResult {
  presetId: string;
  source: string;
  protocol: 'imap' | 'pop3';
  incoming?: ServerSettings;
  smtp?: ServerSettings;
  username: string;
}

export type SpecialUse = '\\Inbox' | '\\Drafts' | '\\Sent' | '\\Trash' | '\\Junk' | '\\Archive' | '\\All' | '\\Flagged';

export interface Folder {
  path: string;
  name: string;
  delimiter: string;
  specialUse: SpecialUse | null;
  unseen: number;
  total: number;
  selectable: boolean;
}

export interface Addr {
  name: string;
  address: string;
}

export interface MessageSummary {
  id: number;
  subject: string;
  from: Addr | null;
  to: Addr[];
  date: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachments: boolean;
  size: number;
}

export interface ListResult {
  total: number;
  page: number;
  pageSize: number;
  messages: MessageSummary[];
}

export interface AttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
}

export interface FullMessage {
  id: number;
  folder: string;
  size: number;
  subject: string;
  from: Addr[];
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo: Addr[];
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  html: string | null;
  text: string;
  hasRemoteContent: boolean;
  attachments: AttachmentInfo[];
}

export interface MailRef {
  accountId: number;
  folder: string;
}
