import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { HttpError, badRequest } from '../http.js';
import { request, statusError, type DavResponse } from './http.js';
import { deleteOccurrence, editObject, newObject, type EventFields } from './ical.js';
import {
  type CalendarRow,
  type SourceRow,
  deleteObject,
  objectEtags,
  objectsByUid,
  putObject,
  readSourceSecret,
  removeCalendarsExcept,
  updateCalendar,
  upsertCalendar,
} from './store.js';

/* CalDAV (RFC 4791): iCloud, Fastmail, Nextcloud, Radicale, Baïkal, Synology, Yahoo, ... */

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  isArray: (name) => ['response', 'propstat', 'comp', 'privilege', 'href'].includes(name),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Xml = any;

interface DavResource {
  href: string;
  props: Record<string, Xml>;
}

const text = (v: Xml): string => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim();

function parseMultistatus(res: DavResponse): DavResource[] {
  let doc: Xml;
  try {
    doc = parser.parse(res.body);
  } catch {
    throw new HttpError(502, 'The calendar server sent a response HomeMail could not read');
  }
  const out: DavResource[] = [];
  for (const r of doc?.multistatus?.response ?? []) {
    const href = text(r.href?.[0]);
    if (!href) continue;
    const props: Record<string, Xml> = {};
    for (const ps of r.propstat ?? []) {
      if (!/\s2\d\d\s/.test(` ${text(ps.status)} `)) continue;
      Object.assign(props, ps.prop ?? {});
    }
    out.push({ href: new URL(href, res.url).toString(), props });
  }
  return out;
}

export interface DavAuth {
  user: string;
  pass: string;
  insecureTls: boolean;
}

async function dav(method: string, url: string, auth: DavAuth, body: string, depth: '0' | '1'): Promise<DavResponse> {
  return request(url, {
    method,
    body,
    auth: { user: auth.user, pass: auth.pass },
    insecureTls: auth.insecureTls,
    headers: { 'content-type': 'application/xml; charset=utf-8', depth },
  });
}

const PROPFIND = (props: string) =>
  `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/"><d:prop>${props}</d:prop></d:propfind>`;

const CALENDAR_PROPS =
  '<d:resourcetype/><d:displayname/><cs:getctag/><d:sync-token/><a:calendar-color/><a:calendar-order/><c:supported-calendar-component-set/><d:current-user-privilege-set/>';

export interface DavCalendar {
  url: string;
  name: string;
  color: string | null;
  ctag: string | null;
  readOnly: boolean;
  order: number;
}

function asCalendar(r: DavResource): DavCalendar | null {
  const rt = r.props.resourcetype;
  if (!rt || typeof rt !== 'object' || !('calendar' in rt)) return null;
  const comps = r.props['supported-calendar-component-set']?.comp as Xml[] | undefined;
  if (comps && !comps.some((c) => String(c['@name']).toUpperCase() === 'VEVENT')) return null;
  const privs = (r.props['current-user-privilege-set']?.privilege ?? []) as Xml[];
  const canWrite = !privs.length || privs.some((p) => p && typeof p === 'object' && ('write' in p || 'write-content' in p || 'all' in p || 'bind' in p));
  return {
    url: r.href.endsWith('/') ? r.href : r.href + '/',
    name: text(r.props.displayname) || decodeURIComponent(new URL(r.href).pathname.split('/').filter(Boolean).pop() || 'Calendar'),
    color: text(r.props['calendar-color']) || null,
    ctag: text(r.props.getctag) || text(r.props['sync-token']) || null,
    readOnly: !canWrite,
    order: Number(text(r.props['calendar-order'])) || 0,
  };
}

/** Finds the calendars of an account from a server URL, following RFC 6764 discovery. */
export async function discover(url: string, auth: DavAuth): Promise<{ home: string; calendars: DavCalendar[] }> {
  let start: URL;
  try {
    start = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    throw badRequest('That server address is not a valid URL');
  }
  // The address as given, then the well-known location (which usually redirects).
  const candidates = [start.toString(), new URL('/.well-known/caldav', start).toString()];

  let lastErr: Error | null = null;
  for (const candidate of candidates) {
    const res = await dav('PROPFIND', candidate, auth, PROPFIND('<d:current-user-principal/><c:calendar-home-set/>' + CALENDAR_PROPS), '0');
    if (res.status === 401) throw statusError(res, 'Sign-in failed');
    if (res.status !== 207) {
      lastErr = statusError(res, 'No CalDAV service found');
      continue;
    }
    const [self] = parseMultistatus(res);
    if (!self) continue;
    // The URL may point straight at one calendar.
    const one = asCalendar(self);
    if (one) return { home: one.url, calendars: [one] };

    let home = text(self.props['calendar-home-set']?.href?.[0]);
    if (!home) {
      const principal = text(self.props['current-user-principal']?.href?.[0]);
      if (!principal) {
        lastErr = new HttpError(502, 'The server did not say where your calendars are');
        continue;
      }
      const pres = await dav('PROPFIND', new URL(principal, res.url).toString(), auth, PROPFIND('<c:calendar-home-set/>'), '0');
      if (pres.status !== 207) throw statusError(pres, 'Could not read your account');
      home = text(parseMultistatus(pres)[0]?.props['calendar-home-set']?.href?.[0]);
      if (!home) throw new HttpError(502, 'The server did not say where your calendars are');
      home = new URL(home, pres.url).toString();
    } else {
      home = new URL(home, res.url).toString();
    }
    return { home, calendars: await listCalendars(home, auth) };
  }
  throw lastErr ?? new HttpError(502, 'No CalDAV service found at that address');
}

export async function listCalendars(home: string, auth: DavAuth): Promise<DavCalendar[]> {
  const res = await dav('PROPFIND', home, auth, PROPFIND(CALENDAR_PROPS), '1');
  if (res.status !== 207) throw statusError(res, 'Could not list calendars');
  return parseMultistatus(res)
    .map(asCalendar)
    .filter((c): c is DavCalendar => !!c);
}

export function sourceAuth(source: SourceRow): DavAuth {
  return { user: source.username ?? '', pass: readSourceSecret(source).password ?? '', insecureTls: !!source.allow_insecure_tls };
}

/** Refreshes the calendar list and fetches whatever changed. */
export async function syncCaldav(source: SourceRow): Promise<void> {
  const auth = sourceAuth(source);
  if (!source.url) throw badRequest('This calendar account has no server address');
  const remote = await listCalendars(source.url, auth);
  const keep: number[] = [];
  for (const rc of remote) {
    const cal = upsertCalendar(source.user_id, source.id, rc.url, { name: rc.name, color: rc.color, readOnly: rc.readOnly, order: rc.order });
    keep.push(cal.id);
    if (rc.ctag && cal.sync_state === rc.ctag) continue;
    await syncCollection(cal, auth);
    updateCalendar(cal.id, { sync_state: rc.ctag });
  }
  removeCalendarsExcept(source.id, keep);
}

const QUERY = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>`;
const MULTIGET = (hrefs: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>${hrefs
    .map((h) => `<d:href>${escapeXml(new URL(h).pathname)}</d:href>`)
    .join('')}</c:calendar-multiget>`;
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function syncCollection(cal: CalendarRow, auth: DavAuth): Promise<void> {
  const res = await dav('REPORT', cal.remote_id, auth, QUERY, '1');
  if (res.status !== 207) throw statusError(res, `Could not read "${cal.name}"`);
  const remote = new Map(parseMultistatus(res).filter((r) => !r.href.endsWith('/')).map((r) => [r.href, text(r.props.getetag) || null]));
  const local = objectEtags(cal.id);
  for (const href of local.keys()) if (!remote.has(href)) deleteObject(cal.id, href);
  const changed = [...remote].filter(([href, etag]) => !etag || local.get(href) !== etag).map(([href]) => href);
  for (let i = 0; i < changed.length; i += 50) {
    const batch = changed.slice(i, i + 50);
    const mres = await dav('REPORT', cal.remote_id, auth, MULTIGET(batch), '1');
    if (mres.status === 207) {
      for (const r of parseMultistatus(mres)) {
        const data = text(r.props['calendar-data']);
        if (data) putObject(cal.id, r.href, { etag: text(r.props.getetag) || null, ics: data });
      }
    } else {
      // Some servers don't do multiget; fetch one at a time.
      for (const href of batch) {
        const g = await request(href, { auth, insecureTls: auth.insecureTls });
        if (g.status === 200) putObject(cal.id, href, { etag: (g.headers.etag as string) ?? null, ics: g.body });
      }
    }
  }
}

async function put(cal: CalendarRow, auth: DavAuth, href: string, ics: string, etag: string | null | 'new'): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'text/calendar; charset=utf-8' };
  if (etag === 'new') headers['if-none-match'] = '*';
  else if (etag) headers['if-match'] = etag;
  const res = await request(href, { method: 'PUT', body: ics, headers, auth, insecureTls: auth.insecureTls });
  if (res.status < 200 || res.status >= 300) throw statusError(res, 'Saving the event failed');
  // Without an ETag the next sync fetches the server's version of the object.
  putObject(cal.id, href, { etag: (res.headers.etag as string) ?? null, ics });
}

function storedObject(cal: CalendarRow, uid: string) {
  const [row] = objectsByUid(cal.id, uid);
  if (!row) throw new HttpError(404, 'Event not found. It may have been removed elsewhere.');
  return row;
}

export async function createCaldav(source: SourceRow, cal: CalendarRow, uid: string, f: EventFields): Promise<void> {
  await put(cal, sourceAuth(source), new URL(`${crypto.randomUUID()}.ics`, cal.remote_id).toString(), newObject(uid, f), 'new');
}

export async function updateCaldav(source: SourceRow, cal: CalendarRow, uid: string, f: EventFields, scope: 'series' | 'occurrence', rid: string | null): Promise<void> {
  const row = storedObject(cal, uid);
  await put(cal, sourceAuth(source), row.remote_id, editObject(row.ics, f, scope, rid), row.etag);
}

export async function deleteCaldav(source: SourceRow, cal: CalendarRow, uid: string, scope: 'series' | 'occurrence', rid: string | null): Promise<void> {
  const auth = sourceAuth(source);
  const row = storedObject(cal, uid);
  const remaining = scope === 'occurrence' && rid ? deleteOccurrence(row.ics, rid) : null;
  if (remaining) return put(cal, auth, row.remote_id, remaining, row.etag);
  const res = await request(row.remote_id, { method: 'DELETE', headers: row.etag ? { 'if-match': row.etag } : {}, auth, insecureTls: auth.insecureTls });
  if (res.status !== 404 && (res.status < 200 || res.status >= 300)) throw statusError(res, 'Deleting the event failed');
  deleteObject(cal.id, row.remote_id);
}

