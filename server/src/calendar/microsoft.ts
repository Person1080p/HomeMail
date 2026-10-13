import { HttpError, badRequest } from '../http.js';
import { fieldInstants, plainToIcs, type EventFields, type SeriesInfo } from './ical.js';
import { apiRequest } from './oauth.js';
import { windowsZoneFor } from './tz.js';
import {
  type CalendarRow,
  type SourceRow,
  deleteObject,
  deleteObjectsBySeries,
  objectEtags,
  objectsByUid,
  putObject,
  removeCalendarsExcept,
  upsertCalendar,
} from './store.js';

/* Microsoft Graph (Outlook.com, Microsoft 365). Graph has no change token for
   calendar views of a single calendar, so each sync reads a window of expanded
   occurrences: six months back to eighteen months ahead. */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const BACK_DAYS = 183;
const AHEAD_DAYS = 548;
const PREFER = { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' };

interface MTime {
  dateTime: string;
  timeZone: string;
}

interface Pattern {
  type: 'daily' | 'weekly' | 'absoluteMonthly' | 'relativeMonthly' | 'absoluteYearly' | 'relativeYearly';
  interval: number;
  daysOfWeek?: string[];
  dayOfMonth?: number;
  month?: number;
  index?: 'first' | 'second' | 'third' | 'fourth' | 'last';
  firstDayOfWeek?: string;
}

interface Range {
  type: 'endDate' | 'noEnd' | 'numbered';
  startDate: string;
  endDate?: string;
  numberOfOccurrences?: number;
  recurrenceTimeZone?: string;
}

interface MEvent {
  id: string;
  changeKey?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string };
  location?: { displayName?: string };
  start: MTime;
  end: MTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  seriesMasterId?: string | null;
  recurrence?: { pattern: Pattern; range: Range } | null;
}

const m = <T>(source: SourceRow, method: string, path: string, body?: unknown) =>
  apiRequest<T>(source, 'Microsoft', method, path.startsWith('https://') ? path : GRAPH + path, body, PREFER);

export async function syncMicrosoft(source: SourceRow): Promise<void> {
  const list = await m<{ value: { id: string; name: string; hexColor?: string; canEdit?: boolean; isDefaultCalendar?: boolean }[] }>(source, 'GET', '/me/calendars?$top=100');
  const keep: number[] = [];
  let order = 0;
  for (const c of list.value) {
    const cal = upsertCalendar(source.user_id, source.id, c.id, {
      name: c.name,
      color: c.hexColor || null,
      readOnly: c.canEdit === false,
      isDefault: !!c.isDefaultCalendar,
      order: c.isDefaultCalendar ? -1 : order++,
    });
    keep.push(cal.id);
    await syncWindow(source, cal);
  }
  removeCalendarsExcept(source.id, keep);
}

/** "2026-01-31T09:00:00.0000000" in UTC (we ask Graph for UTC) to milliseconds. */
const utcMs = (t: MTime) => Date.parse(t.dateTime.replace(/(\.\d{3})\d*$/, '$1') + (/[zZ]|[+-]\d\d:\d\d$/.test(t.dateTime) ? '' : 'Z'));

/** All-day events come back as midnight in their own zone converted to UTC; round to the nearest day. */
const allDayDate = (t: MTime) => new Date(utcMs(t) + 12 * 3600_000).toISOString().slice(0, 10);

async function syncWindow(source: SourceRow, cal: CalendarRow): Promise<void> {
  const from = new Date(Date.now() - BACK_DAYS * 86400_000).toISOString();
  const to = new Date(Date.now() + AHEAD_DAYS * 86400_000).toISOString();
  const select = 'id,changeKey,subject,body,location,start,end,isAllDay,isCancelled,showAs,type,seriesMasterId';
  let url: string | undefined = `/me/calendars/${encodeURIComponent(cal.remote_id)}/calendarView?${new URLSearchParams({ startDateTime: from, endDateTime: to, $top: '500', $select: select })}`;
  const seen = new Set<string>();
  const known = objectEtags(cal.id);
  while (url) {
    const page: { value: MEvent[]; '@odata.nextLink'?: string } = await m(source, 'GET', url);
    for (const e of page.value) {
      seen.add(e.id);
      if (e.changeKey && known.get(e.id) === e.changeKey) continue;
      storeEvent(cal, e);
    }
    url = page['@odata.nextLink'];
  }
  for (const id of known.keys()) if (!seen.has(id)) deleteObject(cal.id, id);
}

function storeEvent(cal: CalendarRow, e: MEvent): void {
  const allDay = !!e.isAllDay;
  const ics = plainToIcs({
    uid: e.id,
    summary: e.subject ?? '',
    location: e.location?.displayName ?? '',
    description: (e.body?.content ?? e.bodyPreview ?? '').trim(),
    status: e.isCancelled ? 'cancelled' : e.showAs === 'tentative' ? 'tentative' : 'confirmed',
    start: allDay ? allDayDate(e.start) : utcMs(e.start),
    end: allDay ? allDayDate(e.end) : utcMs(e.end),
  });
  putObject(cal.id, e.id, { etag: e.changeKey ?? null, uid: e.id, seriesId: e.seriesMasterId ?? null, ics });
}

/* ---------- repeat patterns ---------- */

const DAY_NAMES: Record<string, string> = { SU: 'sunday', MO: 'monday', TU: 'tuesday', WE: 'wednesday', TH: 'thursday', FR: 'friday', SA: 'saturday' };
const DAY_CODES = Object.fromEntries(Object.entries(DAY_NAMES).map(([k, v]) => [v, k]));
const INDEX: Record<string, Pattern['index']> = { '1': 'first', '2': 'second', '3': 'third', '4': 'fourth', '-1': 'last' };
const INDEX_N = Object.fromEntries(Object.entries(INDEX).map(([k, v]) => [v, k]));

/** RRULE to a Graph recurrence. Graph can't express everything RRULE can; those rules are refused. */
function toPattern(rrule: string, startDate: string, tz: string): { pattern: Pattern; range: Range } {
  const parts = Object.fromEntries(rrule.split(';').map((p) => p.split('=') as [string, string]));
  const interval = Number(parts.INTERVAL || 1);
  const start = new Date(startDate + 'T00:00:00Z');
  const byDay = parts.BYDAY ? parts.BYDAY.split(',') : [];
  const unsupported = () => badRequest('Outlook calendars cannot store this repeat pattern');
  let pattern: Pattern;
  switch (parts.FREQ) {
    case 'DAILY':
      pattern = { type: 'daily', interval };
      break;
    case 'WEEKLY': {
      const days = (byDay.length ? byDay : [Object.keys(DAY_NAMES)[start.getUTCDay()]]).map((d) => DAY_NAMES[d]);
      if (days.some((d) => !d)) throw unsupported();
      pattern = { type: 'weekly', interval, daysOfWeek: days, firstDayOfWeek: 'sunday' };
      break;
    }
    case 'MONTHLY':
    case 'YEARLY': {
      const yearly = parts.FREQ === 'YEARLY';
      const month = Number(parts.BYMONTH || start.getUTCMonth() + 1);
      const rel = byDay.length === 1 ? /^([+-]?\d)?([A-Z]{2})$/.exec(byDay[0]) : null;
      const pos = rel?.[1] ?? parts.BYSETPOS;
      if (rel && pos && INDEX[String(Number(pos))]) {
        pattern = { type: yearly ? 'relativeYearly' : 'relativeMonthly', interval, daysOfWeek: [DAY_NAMES[rel[2]]], index: INDEX[String(Number(pos))], ...(yearly ? { month } : {}) };
      } else if (!byDay.length) {
        pattern = { type: yearly ? 'absoluteYearly' : 'absoluteMonthly', interval, dayOfMonth: Number(parts.BYMONTHDAY || start.getUTCDate()), ...(yearly ? { month } : {}) };
      } else throw unsupported();
      break;
    }
    default:
      throw unsupported();
  }
  const range: Range = { type: 'noEnd', startDate, recurrenceTimeZone: tz };
  if (parts.COUNT) Object.assign(range, { type: 'numbered', numberOfOccurrences: Number(parts.COUNT) });
  else if (parts.UNTIL) Object.assign(range, { type: 'endDate', endDate: `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}` });
  return { pattern, range };
}

function toRrule(r: { pattern: Pattern; range: Range }): string {
  const p = r.pattern;
  const out: string[] = [];
  const days = (p.daysOfWeek ?? []).map((d) => DAY_CODES[d.toLowerCase()]).filter(Boolean);
  switch (p.type) {
    case 'daily':
      out.push('FREQ=DAILY');
      break;
    case 'weekly':
      out.push('FREQ=WEEKLY', `BYDAY=${days.join(',')}`);
      break;
    case 'absoluteMonthly':
      out.push('FREQ=MONTHLY', `BYMONTHDAY=${p.dayOfMonth}`);
      break;
    case 'relativeMonthly':
      out.push('FREQ=MONTHLY', `BYDAY=${days.map((d) => INDEX_N[p.index ?? 'first'] + d).join(',')}`);
      break;
    case 'absoluteYearly':
      out.push('FREQ=YEARLY', `BYMONTH=${p.month}`, `BYMONTHDAY=${p.dayOfMonth}`);
      break;
    case 'relativeYearly':
      out.push('FREQ=YEARLY', `BYMONTH=${p.month}`, `BYDAY=${days.map((d) => INDEX_N[p.index ?? 'first'] + d).join(',')}`);
      break;
  }
  if (p.interval > 1) out.push(`INTERVAL=${p.interval}`);
  if (r.range.type === 'numbered' && r.range.numberOfOccurrences) out.push(`COUNT=${r.range.numberOfOccurrences}`);
  if (r.range.type === 'endDate' && r.range.endDate) out.push(`UNTIL=${r.range.endDate.replaceAll('-', '')}`);
  return out.join(';');
}

/* ---------- writing ---------- */

function toGraph(f: EventFields, withRecurrence: boolean) {
  const { start, end } = fieldInstants(f);
  const zone = windowsZoneFor(f.timeZone) ?? f.timeZone;
  const time = (wall: string, ms: number): MTime =>
    f.allDay
      ? { dateTime: `${wall}T00:00:00`, timeZone: 'UTC' }
      : f.rrule && withRecurrence
        ? // A repeating meeting must keep its local time across DST changes.
          { dateTime: `${wall}:00`, timeZone: zone }
        : { dateTime: new Date(ms).toISOString().slice(0, 19), timeZone: 'UTC' };
  return {
    subject: f.summary,
    body: { contentType: 'text', content: f.description },
    location: { displayName: f.location },
    isAllDay: f.allDay,
    start: time(f.start, start),
    end: time(f.end, end),
    ...(withRecurrence ? { recurrence: f.rrule ? toPattern(f.rrule, f.start.slice(0, 10), zone) : null } : {}),
  };
}

function stored(cal: CalendarRow, uid: string) {
  const [row] = objectsByUid(cal.id, uid);
  if (!row) throw new HttpError(404, 'Event not found. It may have been removed elsewhere.');
  return row;
}

export async function createMicrosoft(source: SourceRow, cal: CalendarRow, _uid: string, f: EventFields): Promise<void> {
  await m(source, 'POST', `/me/calendars/${encodeURIComponent(cal.remote_id)}/events`, toGraph(f, true));
  await syncWindow(source, cal);
}

export async function updateMicrosoft(source: SourceRow, cal: CalendarRow, uid: string, f: EventFields, scope: 'series' | 'occurrence'): Promise<void> {
  const row = stored(cal, uid);
  const series = scope === 'series' || !row.series_id;
  await m(source, 'PATCH', `/me/events/${encodeURIComponent(series ? (row.series_id ?? row.remote_id) : row.remote_id)}`, toGraph(f, series));
  await syncWindow(source, cal);
}

export async function deleteMicrosoft(source: SourceRow, cal: CalendarRow, uid: string, scope: 'series' | 'occurrence'): Promise<void> {
  const row = stored(cal, uid);
  const id = scope === 'series' && row.series_id ? row.series_id : row.remote_id;
  await m(source, 'DELETE', `/me/events/${encodeURIComponent(id)}`).catch((err) => {
    if (!(err instanceof HttpError && err.status === 404)) throw err;
  });
  if (scope === 'series' && row.series_id) deleteObjectsBySeries(cal.id, row.series_id);
  else deleteObject(cal.id, row.remote_id);
  await syncWindow(source, cal);
}

/** The series an occurrence belongs to, read from Graph since only occurrences are stored. */
export async function seriesMicrosoft(source: SourceRow, cal: CalendarRow, uid: string): Promise<SeriesInfo | null> {
  const row = stored(cal, uid);
  if (!row.series_id) return null;
  const e = await m<MEvent>(source, 'GET', `/me/events/${encodeURIComponent(row.series_id)}?$select=subject,body,location,start,end,isAllDay,recurrence`);
  const allDay = !!e.isAllDay;
  return {
    summary: e.subject ?? '',
    location: e.location?.displayName ?? '',
    description: (e.body?.content ?? '').trim(),
    allDay,
    start: allDay ? allDayDate(e.start) : new Date(utcMs(e.start)).toISOString(),
    end: allDay ? allDayDate(e.end) : new Date(utcMs(e.end)).toISOString(),
    rrule: e.recurrence ? toRrule(e.recurrence) : null,
  };
}
