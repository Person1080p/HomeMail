export interface Addr {
  name: string;
  address: string;
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

export interface ListOptions {
  page: number;
  pageSize: number;
  query?: string;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
}

export interface ListResult {
  total: number;
  page: number;
  pageSize: number;
  messages: MessageSummary[];
}

export interface FlagChange {
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
}

/** Common surface over live IMAP and the local store used for POP3 accounts. */
export interface MailBackend {
  listFolders(): Promise<Folder[]>;
  listMessages(folder: string, opts: ListOptions): Promise<ListResult>;
  getSource(folder: string, id: number): Promise<Buffer>;
  setFlags(folder: string, ids: number[], change: FlagChange): Promise<void>;
  move(folder: string, ids: number[], dest: string): Promise<void>;
  /** Moves to Trash, or deletes permanently when already in Trash or when `permanent` is set. */
  remove(folder: string, ids: number[], permanent?: boolean): Promise<void>;
  storeSent(raw: Buffer): Promise<void>;
  /** Saves a draft and returns where it was stored so it can be replaced later. */
  saveDraft(raw: Buffer): Promise<{ folder: string; id: number | null }>;
  specialFolder(use: SpecialUse): Promise<string | null>;
  createFolder(path: string): Promise<void>;
  renameFolder(path: string, newPath: string): Promise<void>;
  deleteFolder(path: string): Promise<void>;
  emptyFolder(path: string): Promise<void>;
  /** Fetches new mail where that is a separate step (POP3). */
  sync?(): Promise<{ fetched: number }>;
}

export const FOLDER_ORDER: (SpecialUse | null)[] = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];
