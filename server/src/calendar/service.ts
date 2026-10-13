import { db } from '../db.js';
import { HttpError, badRequest, describeMailError } from '../http.js';
import { publish } from '../events.js';
import type { OAuthIdentity, PendingOAuth } from '../oauth.js';
import { createCaldav, deleteCaldav, syncCaldav, updateCaldav } from './caldav.js';
import { syncFeed } from './feed.js';
import { createGoogle, deleteGoogle, syncGoogle, updateGoogle } from './google.js';
import { deleteOccurrence, editObject, expand, newObject, newUid, seriesInfo, validateFields, type EventFields, type Occurrence, type SeriesInfo, type Window } from './ical.js';
import { createMicrosoft, deleteMicrosoft, seriesMicrosoft, syncMicrosoft, updateMicrosoft } from './microsoft.js';
import {
  type CalendarRow,
  type SourceRow,
  calendarsOf,
  createSource,
  deleteObject,
  getCalendar,
  getSource,
  getSourceById,
  listCalendars,
  listSources,
  objectsByUid,
  objectsInRange,
  putObject,
  readSourceSecret,
  setSourceStatus,
  writeSourceSecret,
} from './store.js';

export type Scope = 'series' | 'occurrence';

/* ---------- syncing ---------- */

const syncing = new Map<number, Promise<void>>();

const changed = (userId: number) => publish(userId, 'calendar.changed', {});

/** Syncs one source; concurrent calls share the run in progress. Records any error on the source. */
export function syncSource(sourceId: number): Promise<void> {
  let p = syncing.get(sourceId);
  if (p) return p;
  p = (async () => {
    const source = getSourceById(sourceId);
    if (!source || source.kind === 'local') return;
    try {
      if (source.kind === 'caldav') await syncCaldav(source);
      else if (source.kind === 'google') await syncGoogle(source);
      else if (source.kind === 'microsoft') await syncMicrosoft(source);
      else if (source.kind === 'ics') await syncFeed(source);
      setSourceStatus(source.id, null, true);
    } catch (err) {
      setSourceStatus(source.id, err instanceof HttpError ? err.message : describeMailError(err), true);
      throw err;
    } finally {
      changed(source.user_id);
    }
  })().finally(() => syncing.delete(sourceId));
  syncing.set(sourceId, p);
  return p;
}

/** Starts syncing the user's sources that haven't synced in `maxAgeMs`, without waiting. */
export function syncStale(userId: number, maxAgeMs: number): void {
  for (const s of listSources(userId)) {
    if (s.kind !== 'local' && (!s.last_sync || Date.now() - s.last_sync > maxAgeMs)) syncSource(s.id).catch(() => {});
  }
}

export function startCalendarSync(): void {
  const minutes = Number(process.env.CALENDAR_SYNC_MINUTES || 15);
  if (!(minutes > 0)) return;
  setInterval(() => {
    const ids = db.prepare("SELECT id FROM calendar_sources WHERE kind != 'local'").pluck().all() as number[];
    (async () => {
      for (const id of ids) await syncSource(id).catch(() => {});
    })();
  }, minutes * 60_000).unref();
}

/* ---------- reading ---------- */

export interface CalendarOccurrence extends Occurrence {
  calendarId: number;
}

export function listOccurrences(userId: number, w: Window): CalendarOccurrence[] {
  const cals = listCalendars(userId).filter((c) => c.visible);
  const kinds = new Map(cals.map((c) => [c.id, c.kind]));
  const rows = objectsInRange(
    cals.map((c) => c.id),
    w.from,
    w.to,
  );
  const out: CalendarOccurrence[] = [];
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j < rows.length && rows[j].calendar_id === rows[i].calendar_id && rows[j].uid === rows[i].uid) j++;
    const group = rows.slice(i, j);
    const calendarId = rows[i].calendar_id;
    const seriesId = group.find((r) => r.series_id)?.series_id;
    try {
      for (const o of expand(
        group.map((r) => r.ics),
        w,
      )) {
        // Microsoft occurrences are stored one by one; mark them as part of their series.
        if (kinds.get(calendarId) === 'microsoft' && seriesId) out.push({ ...o, calendarId, recurring: true, recurrenceId: o.start });
        else out.push({ ...o, calendarId });
      }
    } catch (err) {
      console.warn(`[calendar] skipping unreadable event ${rows[i].uid} in calendar ${calendarId}:`, err instanceof Error ? err.message : err);
    }
    i = j;
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

export async function getSeries(userId: number, calendarId: number, uid: string, tz: string): Promise<SeriesInfo> {
  const { cal, source } = getCalendar(userId, calendarId);
  const info = source.kind === 'microsoft' ? await seriesMicrosoft(source, cal, uid) : seriesInfo(objectsByUid(cal.id, uid).map((r) => r.ics), tz);
  if (!info) throw new HttpError(404, 'Event not found');
  return info;
}

/* ---------- writing ---------- */

function writable(userId: number, calendarId: number): { cal: CalendarRow; source: SourceRow } {
  const r = getCalendar(userId, calendarId);
  if (r.cal.read_only || r.source.kind === 'ics') throw badRequest(`"${r.cal.name}" is read-only`);
  return r;
}

function localObject(cal: CalendarRow, uid: string) {
  const [row] = objectsByUid(cal.id, uid);
  if (!row) throw new HttpError(404, 'Event not found');
  return row;
}

export async function createEvent(userId: number, calendarId: number, f: EventFields): Promise<void> {
  validateFields(f);
  const { cal, source } = writable(userId, calendarId);
  const uid = newUid();
  if (source.kind === 'local') putObject(cal.id, uid, { uid, ics: newObject(uid, f) });
  else if (source.kind === 'caldav') await createCaldav(source, cal, uid, f);
  else if (source.kind === 'google') await createGoogle(source, cal, uid, f);
  else if (source.kind === 'microsoft') await createMicrosoft(source, cal, uid, f);
  changed(userId);
}

export async function updateEvent(userId: number, calendarId: number, uid: string, f: EventFields, scope: Scope, rid: string | null): Promise<void> {
  validateFields(f);
  const { cal, source } = writable(userId, calendarId);
  if (source.kind === 'local') {
    const row = localObject(cal, uid);
    putObject(cal.id, row.remote_id, { uid, ics: editObject(row.ics, f, scope, rid) });
  } else if (source.kind === 'caldav') await updateCaldav(source, cal, uid, f, scope, rid);
  else if (source.kind === 'google') await updateGoogle(source, cal, uid, f, scope, rid);
  else if (source.kind === 'microsoft') await updateMicrosoft(source, cal, uid, f, scope);
  changed(userId);
}

export async function deleteEvent(userId: number, calendarId: number, uid: string, scope: Scope, rid: string | null): Promise<void> {
  const { cal, source } = writable(userId, calendarId);
  if (source.kind === 'local') {
    const row = localObject(cal, uid);
    const remaining = scope === 'occurrence' && rid ? deleteOccurrence(row.ics, rid) : null;
    if (remaining) putObject(cal.id, row.remote_id, { uid, ics: remaining });
    else deleteObject(cal.id, row.remote_id);
  } else if (source.kind === 'caldav') await deleteCaldav(source, cal, uid, scope, rid);
  else if (source.kind === 'google') await deleteGoogle(source, cal, uid, scope, rid);
  else if (source.kind === 'microsoft') await deleteMicrosoft(source, cal, uid, scope);
  changed(userId);
}

/* ---------- accounts ---------- */

/** Finishes "Sign in with Google/Microsoft" for calendars: adds or reconnects the source. */
export function connectOAuthCalendar(p: PendingOAuth, ident: OAuthIdentity): 'added' | 'reconnected' {
  let source: SourceRow | undefined;
  if (p.sourceId) {
    source = getSource(p.userId, p.sourceId);
    if ((source.username ?? '').toLowerCase() !== ident.email) throw badRequest(`You signed in as ${ident.email}, but this calendar account is ${source.username}`);
  } else {
    source = listSources(p.userId).find((s) => s.kind === p.provider && (s.username ?? '').toLowerCase() === ident.email);
  }
  const secret = { accessToken: ident.secret.accessToken, refreshToken: ident.secret.refreshToken, expiresAt: ident.secret.expiresAt };
  const result = source ? 'reconnected' : 'added';
  if (source) {
    writeSourceSecret(source.id, { ...readSourceSecret(source), ...secret });
    setSourceStatus(source.id, null, false);
  } else {
    source = createSource(p.userId, { kind: p.provider, provider: p.provider, label: ident.email, url: null, username: ident.email, allow_insecure_tls: 0 }, secret);
  }
  syncSource(source.id).catch(() => {});
  return result;
}

export function publicSource(s: SourceRow) {
  const secret = readSourceSecret(s);
  return {
    id: s.id,
    kind: s.kind,
    provider: s.provider,
    label: s.label,
    url: s.url,
    username: s.username,
    allowInsecureTls: !!s.allow_insecure_tls,
    hasPassword: !!secret.password,
    connected: s.kind === 'google' || s.kind === 'microsoft' ? !!secret.refreshToken : true,
    lastSync: s.last_sync,
    lastError: s.last_error,
    syncing: syncing.has(s.id),
    calendars: calendarsOf(s.id).length,
  };
}

export function publicCalendar(c: CalendarRow & { kind: SourceRow['kind'] }) {
  return {
    id: c.id,
    sourceId: c.source_id,
    name: c.name,
    color: c.color,
    readOnly: !!c.read_only || c.kind === 'ics',
    visible: !!c.visible,
    isDefault: !!c.is_default,
  };
}
