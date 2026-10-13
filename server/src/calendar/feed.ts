import crypto from 'node:crypto';
import { HttpError } from '../http.js';
import { request, statusError } from './http.js';
import { splitByUid } from './ical.js';
import { type SourceRow, deleteObject, objectEtags, putObject, readSourceSecret, removeCalendarsExcept, updateCalendar, upsertCalendar } from './store.js';

/* Subscribed .ics feeds (holidays, sports fixtures, a published Outlook or
   Google calendar, ...). Read-only; fetched whole each time. */

export const feedUrl = (url: string) => url.trim().replace(/^webcals?:\/\//i, 'https://');

export async function fetchFeed(source: Pick<SourceRow, 'url' | 'username' | 'allow_insecure_tls'>, password?: string): Promise<string> {
  const res = await request(feedUrl(source.url ?? ''), {
    headers: { accept: 'text/calendar, */*;q=0.5' },
    auth: source.username ? { user: source.username, pass: password ?? '' } : undefined,
    insecureTls: !!source.allow_insecure_tls,
  });
  if (res.status !== 200) throw statusError(res, 'Could not fetch the calendar');
  if (!res.body.includes('BEGIN:VCALENDAR')) throw new HttpError(502, 'That address did not return an iCalendar (.ics) file');
  return res.body;
}

const header = (ics: string, name: string) => new RegExp(`^${name}:(.*)$`, 'mi').exec(ics.replace(/\r?\n[ \t]/g, ''))?.[1]?.trim() || null;
export const feedName = (ics: string) => header(ics, 'X-WR-CALNAME');

export async function syncFeed(source: SourceRow): Promise<void> {
  const body = await fetchFeed(source, readSourceSecret(source).password);
  const cal = upsertCalendar(source.user_id, source.id, 'feed', {
    name: source.label,
    color: header(body, 'X-APPLE-CALENDAR-COLOR'),
    readOnly: true,
    isDefault: true,
  });
  removeCalendarsExcept(source.id, [cal.id]);
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  if (cal.sync_state === hash) return;
  const known = objectEtags(cal.id);
  const seen = new Set<string>();
  for (const [uid, ics] of splitByUid(body)) {
    seen.add(uid);
    const etag = crypto.createHash('sha1').update(ics).digest('hex');
    if (known.get(uid) !== etag) putObject(cal.id, uid, { uid, etag, ics });
  }
  for (const uid of known.keys()) if (!seen.has(uid)) deleteObject(cal.id, uid);
  updateCalendar(cal.id, { sync_state: hash });
}
