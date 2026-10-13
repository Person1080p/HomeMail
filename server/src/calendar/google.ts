import { HttpError } from '../http.js';
import { plainToIcs, type EventFields, type PlainEvent } from './ical.js';
import { apiRequest } from './oauth.js';
import {
  type CalendarRow,
  type SourceRow,
  clearObjects,
  deleteObject,
  deleteObjectsBySeries,
  objectByRemoteId,
  objectEtags,
  objectsByUid,
  putObject,
  removeCalendarsExcept,
  updateCalendar,
  upsertCalendar,
} from './store.js';

/* Google Calendar API v3. Events keep their recurrence rules; changed or
   cancelled occurrences are separate events stored next to their series. */

const API = 'https://www.googleapis.com/calendar/v3';

interface GTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GEvent {
  id: string;
  etag?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  iCalUID?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: GTime;
  end?: GTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GTime;
}

interface GList<T> {
  items?: T[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

const g = <T>(source: SourceRow, method: string, path: string, body?: unknown) => apiRequest<T>(source, 'Google Calendar', method, API + path, body);
const cid = (cal: CalendarRow) => encodeURIComponent(cal.remote_id);

export async function syncGoogle(source: SourceRow): Promise<void> {
  const keep: number[] = [];
  let pageToken: string | undefined;
  let order = 0;
  do {
    const page = await g<GList<{ id: string; summary: string; summaryOverride?: string; backgroundColor?: string; accessRole: string; primary?: boolean; deleted?: boolean }>>(
      source,
      'GET',
      `/users/me/calendarList?${new URLSearchParams({ maxResults: '250', ...(pageToken ? { pageToken } : {}) })}`,
    );
    for (const item of page.items ?? []) {
      // Free/busy-only calendars have no event details to show.
      if (item.deleted || item.accessRole === 'freeBusyReader') continue;
      const cal = upsertCalendar(source.user_id, source.id, item.id, {
        name: item.summaryOverride || item.summary || item.id,
        color: item.backgroundColor,
        readOnly: item.accessRole !== 'owner' && item.accessRole !== 'writer',
        isDefault: !!item.primary,
        order: item.primary ? -1 : order++,
      });
      keep.push(cal.id);
      await syncEvents(source, cal);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  removeCalendarsExcept(source.id, keep);
}

/** Incremental with the calendar's sync token; a full listing the first time or when Google says the token expired. */
async function syncEvents(source: SourceRow, cal: CalendarRow): Promise<void> {
  const full = !cal.sync_state;
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let syncToken: string | undefined;
  try {
    do {
      const q = new URLSearchParams({ maxResults: '2500' });
      if (cal.sync_state) q.set('syncToken', cal.sync_state);
      if (pageToken) q.set('pageToken', pageToken);
      const page = await g<GList<GEvent>>(source, 'GET', `/calendars/${cid(cal)}/events?${q}`);
      for (const e of page.items ?? []) {
        seen.add(e.id);
        storeEvent(cal, e);
      }
      pageToken = page.nextPageToken;
      syncToken = page.nextSyncToken;
    } while (pageToken);
  } catch (err) {
    if (err instanceof HttpError && err.status === 410 && cal.sync_state) {
      clearObjects(cal.id);
      updateCalendar(cal.id, { sync_state: null });
      return syncEvents(source, { ...cal, sync_state: null });
    }
    throw err;
  }
  if (full) for (const id of objectEtags(cal.id).keys()) if (!seen.has(id)) deleteObject(cal.id, id);
  updateCalendar(cal.id, { sync_state: syncToken ?? null });
  cal.sync_state = syncToken ?? null;
}

function htmlToText(s: string): string {
  if (!/<[a-z][\s\S]*>/i.test(s)) return s;
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

const timeOf = (t: GTime | undefined): string | number | undefined => (t?.date ? t.date : t?.dateTime ? Date.parse(t.dateTime) : undefined);

function storeEvent(cal: CalendarRow, e: GEvent): void {
  if (e.status === 'cancelled' && !e.recurringEventId) {
    deleteObjectsBySeries(cal.id, e.id);
    return;
  }
  // Cancelled occurrences can arrive with nothing but ids and the original time.
  const uid = e.iCalUID || (e.recurringEventId ? objectByRemoteId(cal.id, e.recurringEventId)?.uid : undefined) || e.id;
  const start = timeOf(e.start) ?? timeOf(e.originalStartTime);
  if (start === undefined) return;
  const end = timeOf(e.end) ?? start;
  const plain: PlainEvent = {
    uid,
    summary: e.summary ?? '',
    location: e.location ?? '',
    description: htmlToText(e.description ?? ''),
    status: e.status ?? 'confirmed',
    start,
    end: typeof start === 'string' && typeof end === 'string' && end <= start ? nextDay(start) : end,
    timeZone: e.start?.timeZone ?? e.originalStartTime?.timeZone,
    rrule: e.recurrence,
    recurrenceId: e.recurringEventId ? timeOf(e.originalStartTime) : undefined,
  };
  putObject(cal.id, e.id, { etag: e.etag ?? null, uid, seriesId: e.recurringEventId ?? null, ics: plainToIcs(plain) });
}

function nextDay(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function toGoogle(f: EventFields, withRecurrence: boolean) {
  // Explicit nulls so a PATCH can switch between all-day and timed.
  const time = (v: string): { date: string | null; dateTime: string | null; timeZone: string | null } =>
    f.allDay ? { date: v, dateTime: null, timeZone: null } : { dateTime: `${v}:00`, timeZone: f.timeZone, date: null };
  return {
    summary: f.summary,
    location: f.location,
    description: f.description,
    start: time(f.start),
    end: time(f.end),
    ...(withRecurrence ? { recurrence: f.rrule ? [`RRULE:${f.rrule}`] : [] } : {}),
  };
}

/** The Google event behind a stored event: the series, a stored exception, or an instance looked up by its original time. */
async function targetId(source: SourceRow, cal: CalendarRow, uid: string, scope: 'series' | 'occurrence', rid: string | null): Promise<string> {
  const rows = objectsByUid(cal.id, uid);
  if (!rows.length) throw new HttpError(404, 'Event not found. It may have been removed elsewhere.');
  const master = rows.find((r) => !r.series_id);
  if (scope === 'series' || !rid) return (master ?? rows[0]).remote_id;
  if (!master) return rows[0].remote_id;
  const q = new URLSearchParams({ originalStart: rid, showDeleted: 'false', maxResults: '1' });
  const page = await g<GList<GEvent>>(source, 'GET', `/calendars/${cid(cal)}/events/${encodeURIComponent(master.remote_id)}/instances?${q}`);
  const inst = page.items?.[0];
  if (inst) return inst.id;
  // Google's instance ids are the series id and the original start in basic format.
  return `${master.remote_id}_${rid.replace(/[-:]/g, '')}`;
}

export async function createGoogle(source: SourceRow, cal: CalendarRow, _uid: string, f: EventFields): Promise<void> {
  const e = await g<GEvent>(source, 'POST', `/calendars/${cid(cal)}/events`, toGoogle(f, true));
  storeEvent(cal, e);
}

export async function updateGoogle(source: SourceRow, cal: CalendarRow, uid: string, f: EventFields, scope: 'series' | 'occurrence', rid: string | null): Promise<void> {
  const id = await targetId(source, cal, uid, scope, rid);
  const isSeriesEdit = scope === 'series' || !rid;
  await g<GEvent>(source, 'PATCH', `/calendars/${cid(cal)}/events/${encodeURIComponent(id)}`, toGoogle(f, isSeriesEdit));
  await syncEvents(source, cal);
}

export async function deleteGoogle(source: SourceRow, cal: CalendarRow, uid: string, scope: 'series' | 'occurrence', rid: string | null): Promise<void> {
  const id = await targetId(source, cal, uid, scope, rid);
  await g(source, 'DELETE', `/calendars/${cid(cal)}/events/${encodeURIComponent(id)}`).catch((err) => {
    if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
  });
  if (scope === 'series' || !rid) deleteObjectsBySeries(cal.id, id);
  await syncEvents(source, cal);
}
