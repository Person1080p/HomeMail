import { db, now } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import { notFound } from '../http.js';
import { objectRange } from './ical.js';

export type SourceKind = 'local' | 'caldav' | 'google' | 'microsoft' | 'ics';

export interface SourceRow {
  id: number;
  user_id: number;
  kind: SourceKind;
  provider: string;
  label: string;
  url: string | null;
  username: string | null;
  secret: string | null;
  allow_insecure_tls: number;
  sort_order: number;
  last_sync: number | null;
  last_error: string | null;
  created_at: number;
}

export interface SourceSecret {
  password?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface CalendarRow {
  id: number;
  source_id: number;
  remote_id: string;
  name: string;
  color: string;
  read_only: number;
  visible: number;
  is_default: number;
  sync_state: string | null;
  sort_order: number;
}

export interface ObjectRow {
  id: number;
  calendar_id: number;
  remote_id: string;
  etag: string | null;
  uid: string;
  series_id: string | null;
  ics: string;
  range_start: number;
  range_end: number | null;
}

/** Outlook-like defaults, handed out in turn to new calendars. */
export const PALETTE = ['#2f6fde', '#d13438', '#107c10', '#ca5010', '#8764b8', '#038387', '#c239b3', '#986f0b', '#4f6bed', '#567c73'];

export function nextColor(userId: number): string {
  const n = db
    .prepare('SELECT COUNT(*) AS n FROM calendars c JOIN calendar_sources s ON s.id = c.source_id WHERE s.user_id = ?')
    .get(userId) as { n: number };
  return PALETTE[n.n % PALETTE.length];
}

/* ---------- sources ---------- */

export function listSources(userId: number): SourceRow[] {
  return db.prepare('SELECT * FROM calendar_sources WHERE user_id = ? ORDER BY kind != \'local\', sort_order, id').all(userId) as SourceRow[];
}

export function getSource(userId: number, id: number): SourceRow {
  const row = db.prepare('SELECT * FROM calendar_sources WHERE id = ? AND user_id = ?').get(id, userId) as SourceRow | undefined;
  if (!row) throw notFound('Calendar account not found');
  return row;
}

export function getSourceById(id: number): SourceRow | undefined {
  return db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id) as SourceRow | undefined;
}

export function createSource(
  userId: number,
  s: Pick<SourceRow, 'kind' | 'provider' | 'label' | 'url' | 'username' | 'allow_insecure_tls'>,
  secret: SourceSecret,
): SourceRow {
  const order = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM calendar_sources WHERE user_id = ?').get(userId) as { n: number }).n;
  const info = db
    .prepare(
      `INSERT INTO calendar_sources (user_id, kind, provider, label, url, username, secret, allow_insecure_tls, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, s.kind, s.provider, s.label, s.url, s.username, encrypt(secret), s.allow_insecure_tls, order, now());
  return getSource(userId, Number(info.lastInsertRowid));
}

export function updateSource(id: number, fields: Partial<Pick<SourceRow, 'label' | 'url' | 'username' | 'allow_insecure_tls'>>): void {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (!keys.length) return;
  db.prepare(`UPDATE calendar_sources SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

export function deleteSource(userId: number, id: number): void {
  db.prepare('DELETE FROM calendar_sources WHERE id = ? AND user_id = ?').run(id, userId);
}

export function setSourceStatus(id: number, error: string | null, synced: boolean): void {
  if (synced) db.prepare('UPDATE calendar_sources SET last_error = ?, last_sync = ? WHERE id = ?').run(error, now(), id);
  else db.prepare('UPDATE calendar_sources SET last_error = ? WHERE id = ?').run(error, id);
}

export function readSourceSecret(s: SourceRow): SourceSecret {
  return s.secret ? decrypt<SourceSecret>(s.secret) : {};
}

export function writeSourceSecret(id: number, secret: SourceSecret): void {
  db.prepare('UPDATE calendar_sources SET secret = ? WHERE id = ?').run(encrypt(secret), id);
}

/** Every user gets a calendar stored on this server, created on first use. */
export function ensureLocalSource(userId: number): SourceRow {
  const existing = db.prepare("SELECT * FROM calendar_sources WHERE user_id = ? AND kind = 'local'").get(userId) as SourceRow | undefined;
  if (existing) return existing;
  return db.transaction(() => {
    const src = createSource(userId, { kind: 'local', provider: 'local', label: 'On this server', url: null, username: null, allow_insecure_tls: 0 }, {});
    db.prepare('UPDATE calendar_sources SET sort_order = 0 WHERE id = ?').run(src.id);
    createLocalCalendar(src.id, 'Calendar', PALETTE[0], true);
    return src;
  })();
}

/* ---------- calendars ---------- */

export function listCalendars(userId: number): (CalendarRow & { kind: SourceKind })[] {
  return db
    .prepare(
      `SELECT c.*, s.kind FROM calendars c JOIN calendar_sources s ON s.id = c.source_id
       WHERE s.user_id = ? ORDER BY s.kind != 'local', s.sort_order, s.id, c.is_default DESC, c.sort_order, c.name COLLATE NOCASE`,
    )
    .all(userId) as (CalendarRow & { kind: SourceKind })[];
}

export function calendarsOf(sourceId: number): CalendarRow[] {
  return db.prepare('SELECT * FROM calendars WHERE source_id = ? ORDER BY sort_order, id').all(sourceId) as CalendarRow[];
}

/** Loads a calendar with its source, enforcing that it belongs to the user. */
export function getCalendar(userId: number, id: number): { cal: CalendarRow; source: SourceRow } {
  const cal = db
    .prepare('SELECT c.* FROM calendars c JOIN calendar_sources s ON s.id = c.source_id WHERE c.id = ? AND s.user_id = ?')
    .get(id, userId) as CalendarRow | undefined;
  if (!cal) throw notFound('Calendar not found');
  return { cal, source: getSource(userId, cal.source_id) };
}

export function createLocalCalendar(sourceId: number, name: string, color: string, isDefault = false): CalendarRow {
  const info = db
    .prepare('INSERT INTO calendars (source_id, remote_id, name, color, is_default) VALUES (?, ?, ?, ?, ?)')
    .run(sourceId, `local-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name, color, isDefault ? 1 : 0);
  return db.prepare('SELECT * FROM calendars WHERE id = ?').get(Number(info.lastInsertRowid)) as CalendarRow;
}

/**
 * Records a calendar found on the remote side. Name and permissions follow the
 * server; colour and visibility are the user's once the calendar exists.
 */
export function upsertCalendar(
  userId: number,
  sourceId: number,
  remoteId: string,
  fields: { name: string; color?: string | null; readOnly: boolean; isDefault?: boolean; order?: number },
): CalendarRow {
  const existing = db.prepare('SELECT * FROM calendars WHERE source_id = ? AND remote_id = ?').get(sourceId, remoteId) as CalendarRow | undefined;
  if (existing) {
    db.prepare('UPDATE calendars SET name = ?, read_only = ?, is_default = ?, sort_order = ? WHERE id = ?').run(
      fields.name,
      fields.readOnly ? 1 : 0,
      fields.isDefault ? 1 : 0,
      fields.order ?? existing.sort_order,
      existing.id,
    );
    return { ...existing, name: fields.name, read_only: fields.readOnly ? 1 : 0 };
  }
  const color = normalizeColor(fields.color) ?? nextColor(userId);
  const info = db
    .prepare('INSERT INTO calendars (source_id, remote_id, name, color, read_only, is_default, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sourceId, remoteId, fields.name, color, fields.readOnly ? 1 : 0, fields.isDefault ? 1 : 0, fields.order ?? 0);
  return db.prepare('SELECT * FROM calendars WHERE id = ?').get(Number(info.lastInsertRowid)) as CalendarRow;
}

/** "#RRGGBB" from the colour formats servers use (#RGB, #RRGGBBAA). */
export function normalizeColor(c: string | null | undefined): string | null {
  if (!c) return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
  return `#${hex.toLowerCase()}`;
}

export function removeCalendarsExcept(sourceId: number, keepIds: number[]): void {
  const all = calendarsOf(sourceId);
  const del = db.prepare('DELETE FROM calendars WHERE id = ?');
  for (const c of all) if (!keepIds.includes(c.id)) del.run(c.id);
}

export function updateCalendar(id: number, fields: Partial<Pick<CalendarRow, 'name' | 'color' | 'visible' | 'sync_state'>>): void {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (!keys.length) return;
  db.prepare(`UPDATE calendars SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

export function deleteCalendar(id: number): void {
  db.prepare('DELETE FROM calendars WHERE id = ?').run(id);
}

/* ---------- objects ---------- */

/** Stores an object, or removes it if it holds no events. Returns false if it was skipped. */
export function putObject(calendarId: number, remoteId: string, o: { etag?: string | null; uid?: string; seriesId?: string | null; ics: string }): boolean {
  let range: ReturnType<typeof objectRange>;
  try {
    range = objectRange(o.ics);
  } catch {
    range = null;
  }
  if (!range) {
    deleteObject(calendarId, remoteId);
    return false;
  }
  const uid = o.uid ?? /^UID:(.*)$/m.exec(o.ics.replace(/\r\n[ \t]/g, ''))?.[1]?.trim() ?? remoteId;
  db.prepare(
    `INSERT INTO calendar_objects (calendar_id, remote_id, etag, uid, series_id, ics, range_start, range_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (calendar_id, remote_id) DO UPDATE SET
       etag = excluded.etag, uid = excluded.uid, series_id = excluded.series_id, ics = excluded.ics,
       range_start = excluded.range_start, range_end = excluded.range_end`,
  ).run(calendarId, remoteId, o.etag ?? null, uid, o.seriesId ?? null, o.ics, range.start, range.end);
  return true;
}

export function deleteObject(calendarId: number, remoteId: string): void {
  db.prepare('DELETE FROM calendar_objects WHERE calendar_id = ? AND remote_id = ?').run(calendarId, remoteId);
}

export function deleteObjectsBySeries(calendarId: number, seriesId: string): void {
  db.prepare('DELETE FROM calendar_objects WHERE calendar_id = ? AND (series_id = ? OR remote_id = ?)').run(calendarId, seriesId, seriesId);
}

export function clearObjects(calendarId: number): void {
  db.prepare('DELETE FROM calendar_objects WHERE calendar_id = ?').run(calendarId);
}

export function objectEtags(calendarId: number): Map<string, string | null> {
  const rows = db.prepare('SELECT remote_id, etag FROM calendar_objects WHERE calendar_id = ?').all(calendarId) as { remote_id: string; etag: string | null }[];
  return new Map(rows.map((r) => [r.remote_id, r.etag]));
}

export function objectByRemoteId(calendarId: number, remoteId: string): ObjectRow | undefined {
  return db.prepare('SELECT * FROM calendar_objects WHERE calendar_id = ? AND remote_id = ?').get(calendarId, remoteId) as ObjectRow | undefined;
}

export function objectsByUid(calendarId: number, uid: string): ObjectRow[] {
  return db.prepare('SELECT * FROM calendar_objects WHERE calendar_id = ? AND uid = ? ORDER BY series_id IS NOT NULL, id').all(calendarId, uid) as ObjectRow[];
}

/** Every object of every event that may appear in [from, to], grouped by calendar and UID. */
export function objectsInRange(calendarIds: number[], from: number, to: number): ObjectRow[] {
  if (!calendarIds.length) return [];
  const marks = calendarIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT o.* FROM calendar_objects o
       WHERE o.calendar_id IN (${marks}) AND (o.calendar_id, o.uid) IN (
         SELECT calendar_id, uid FROM calendar_objects
         WHERE calendar_id IN (${marks}) AND range_start <= ? AND (range_end IS NULL OR range_end >= ?)
       )
       ORDER BY o.calendar_id, o.uid, o.id`,
    )
    .all(...calendarIds, ...calendarIds, to, from) as ObjectRow[];
}
