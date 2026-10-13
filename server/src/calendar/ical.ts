import crypto from 'node:crypto';
import ICAL from 'ical.js';
import { badRequest } from '../http.js';
import { ianaFor, isIanaZone, registerZones, utcToWall, vtimezone, zonedToUtc, type Wall } from './tz.js';

type Component = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;

/** What the browser sends when creating or editing an event. */
export interface EventFields {
  summary: string;
  location: string;
  description: string;
  allDay: boolean;
  /** All-day: "YYYY-MM-DD" (end exclusive). Timed: wall time "YYYY-MM-DDTHH:mm" in `timeZone`. */
  start: string;
  end: string;
  timeZone: string;
  /** RRULE value without the "RRULE:" prefix, or null for a single event. */
  rrule: string | null;
}

/** One occurrence of an event, as shown in the calendar. */
export interface Occurrence {
  uid: string;
  /** Identifies the occurrence within a recurring series: a date, or a UTC time ending in Z. */
  recurrenceId: string | null;
  summary: string;
  location: string;
  description: string;
  allDay: boolean;
  /** All-day: "YYYY-MM-DD" (end exclusive). Timed: ISO UTC. */
  start: string;
  end: string;
  recurring: boolean;
  status: 'confirmed' | 'tentative' | 'cancelled';
}

/** The series-level view of an event, for editing the whole series. */
export interface SeriesInfo {
  summary: string;
  location: string;
  description: string;
  allDay: boolean;
  start: string;
  end: string;
  rrule: string | null;
}

export interface Window {
  /** UTC instants bounding the view. */
  from: number;
  to: number;
  /** The same bounds as dates in the viewer's zone, for all-day events. */
  fromDate: string;
  toDate: string;
  /** Zone used for floating times. */
  tz: string;
}

const MAX_ITERATIONS = 20000;
const DAY = 86400_000;
/** All-day and floating times are in no particular zone; allow for any when filtering by range. */
const ZONE_SLACK = 14 * 3600_000;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const dateStr = (t: Time) => `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
const wallOf = (t: Time): Wall => ({ year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second });

const isUtc = (t: Time) => t.zone === ICAL.Timezone.utcTimezone;
const isFloating = (t: Time) => !t.zone || t.zone === ICAL.Timezone.localTimezone || t.zone.tzid === 'floating';

/** UTC milliseconds of a date-time (dates count as UTC midnight). */
function epoch(t: Time, fallbackTz: string): number {
  if (t.isDate || isUtc(t)) return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  if (isFloating(t)) return zonedToUtc(wallOf(t), fallbackTz);
  // Intl knows the zone's history; generated or embedded rules only approximate it.
  const iana = ianaFor(t.zone!.tzid);
  return iana ? zonedToUtc(wallOf(t), iana) : t.toUnixTime() * 1000;
}

/** A stable key for an occurrence's original start, independent of how its zone was written. */
function ridKey(t: Time): string {
  if (t.isDate) return dateStr(t);
  if (isFloating(t)) return t.toString().replace(/Z$/, '');
  return new Date(epoch(t, 'UTC')).toISOString().replace(/\.000Z$/, 'Z');
}

export function parseIcs(ics: string): Component {
  registerZones(ics);
  try {
    const root = new ICAL.Component(ICAL.parse(ics));
    if (root.name !== 'vcalendar') throw new Error('not a VCALENDAR');
    return root;
  } catch (err) {
    throw badRequest(`Invalid calendar data: ${err instanceof Error ? err.message : err}`);
  }
}

const textOf = (c: Component, name: string) => {
  const v = c.getFirstPropertyValue(name);
  return typeof v === 'string' ? v : v == null ? '' : String(v);
};

function statusOf(c: Component): Occurrence['status'] {
  const s = textOf(c, 'status').toLowerCase();
  return s === 'cancelled' || s === 'tentative' ? s : 'confirmed';
}

/** Splits a multi-event VCALENDAR (a feed or an import) into one per UID, keeping the zones each uses. */
export function splitByUid(ics: string): Map<string, string> {
  const root = parseIcs(ics);
  const zones = new Map(root.getAllSubcomponents('vtimezone').map((z) => [textOf(z, 'tzid'), z]));
  const groups = new Map<string, Component[]>();
  for (const ev of root.getAllSubcomponents('vevent')) {
    const uid = textOf(ev, 'uid') || `nouid-${crypto.createHash('sha1').update(ev.toString()).digest('hex')}`;
    if (!groups.has(uid)) groups.set(uid, []);
    groups.get(uid)!.push(ev);
  }
  const out = new Map<string, string>();
  for (const [uid, events] of groups) {
    const cal = emptyCalendar();
    const used = new Set<string>();
    for (const ev of events) {
      for (const prop of ev.getAllProperties()) {
        const tzid = prop.getParameter('tzid');
        if (typeof tzid === 'string') used.add(tzid);
      }
    }
    for (const tzid of used) {
      const z = zones.get(tzid);
      if (z) cal.addSubcomponent(new ICAL.Component(structuredClone(z.toJSON())));
    }
    for (const ev of events) {
      if (!ev.hasProperty('uid')) ev.addPropertyWithValue('uid', uid);
      cal.addSubcomponent(new ICAL.Component(structuredClone(ev.toJSON())));
    }
    out.set(uid, cal.toString());
  }
  return out;
}

function emptyCalendar(): Component {
  const cal = new ICAL.Component(['vcalendar', [], []]);
  cal.addPropertyWithValue('version', '2.0');
  cal.addPropertyWithValue('prodid', '-//HomeMail//Calendar//EN');
  cal.addPropertyWithValue('calscale', 'GREGORIAN');
  return cal;
}

/** The UID of the (first) event in an object. */
export function uidOf(ics: string): string | null {
  const ev = parseIcs(ics).getFirstSubcomponent('vevent');
  return ev ? textOf(ev, 'uid') || null : null;
}

/**
 * The span of time an object can show up in, for indexing: [start, end], with
 * end null when the event repeats forever.
 */
export function objectRange(ics: string): { start: number; end: number | null } | null {
  const root = parseIcs(ics);
  let start = Infinity;
  let end: number | null = -Infinity;
  for (const comp of root.getAllSubcomponents('vevent')) {
    if (!comp.hasProperty('dtstart')) continue;
    const ev = new ICAL.Event(comp);
    const s = ev.startDate;
    const slack = s.isDate || isFloating(s) ? ZONE_SLACK : 0;
    start = Math.min(start, epoch(s, 'UTC') - slack);
    if (comp.hasProperty('recurrence-id')) start = Math.min(start, epoch(comp.getFirstPropertyValue('recurrence-id') as Time, 'UTC') - slack);
    if (end === null) continue;
    const durationMs = Math.max(0, epoch(ev.endDate, 'UTC') - epoch(s, 'UTC'));
    if (!ev.isRecurring()) {
      end = Math.max(end, epoch(ev.endDate, 'UTC') + slack);
      continue;
    }
    const rules = comp.getAllProperties('rrule').map((p) => p.getFirstValue() as InstanceType<typeof ICAL.Recur>);
    if (rules.some((r) => !r.count && !r.until)) {
      end = null;
      continue;
    }
    const it = ev.iterator();
    let last = s;
    for (let i = 0, n; i < 100_000 && (n = it.next()); i++) last = n;
    end = Math.max(end, epoch(last, 'UTC') + durationMs + slack);
  }
  if (start === Infinity) return null;
  return { start, end: end === -Infinity ? start + DAY : end };
}

function occurrenceFrom(comp: Component, s: Time, e: Time, fallbackTz: string, recurrenceId: string | null, recurring: boolean): Occurrence {
  const allDay = s.isDate;
  let start: string;
  let end: string;
  if (allDay) {
    start = dateStr(s);
    // DTEND as a date-time on an all-day event is malformed; dateStr rounds it to the day.
    end = dateStr(e);
    if (end <= start) end = dateStr(addDays(s, 1));
  } else {
    const sm = epoch(s, fallbackTz);
    start = new Date(sm).toISOString();
    end = new Date(Math.max(sm, epoch(e, fallbackTz))).toISOString();
  }
  return {
    uid: textOf(comp, 'uid'),
    recurrenceId,
    summary: textOf(comp, 'summary'),
    location: textOf(comp, 'location'),
    description: textOf(comp, 'description'),
    allDay,
    start,
    end,
    recurring,
    status: statusOf(comp),
  };
}

function addDays(t: Time, n: number): Time {
  const c = t.clone();
  c.adjust(n, 0, 0, 0);
  return c;
}

function overlaps(o: Occurrence, w: Window): boolean {
  if (o.allDay) return o.start < w.toDate && o.end > w.fromDate;
  const s = Date.parse(o.start);
  const e = Date.parse(o.end);
  return s < w.to && (e > w.from || (e === s && s >= w.from));
}

/**
 * The occurrences of one event (every stored object sharing a UID, which for
 * Google means the series plus its separately stored exceptions) in a window.
 */
export function expand(icsList: string[], w: Window): Occurrence[] {
  const masters: Component[] = [];
  const exceptions = new Map<string, Component>();
  for (const ics of icsList) {
    for (const comp of parseIcs(ics).getAllSubcomponents('vevent')) {
      if (!comp.hasProperty('dtstart')) continue;
      if (comp.hasProperty('recurrence-id')) exceptions.set(ridKey(comp.getFirstPropertyValue('recurrence-id') as Time), comp);
      else masters.push(comp);
    }
  }
  const out: Occurrence[] = [];
  const used = new Set<string>();
  for (const comp of masters) {
    const ev = new ICAL.Event(comp);
    if (!ev.isRecurring()) {
      const o = occurrenceFrom(comp, ev.startDate, ev.endDate, w.tz, null, false);
      if (overlaps(o, w)) out.push(o);
      continue;
    }
    const duration = ev.duration;
    const it = ev.iterator();
    for (let i = 0, n: Time | null; i < MAX_ITERATIONS && (n = it.next()); i++) {
      if (n.isDate ? dateStr(n) >= w.toDate : epoch(n, w.tz) >= w.to + ZONE_SLACK) break;
      const key = ridKey(n);
      const exc = exceptions.get(key);
      let o: Occurrence;
      if (exc) {
        used.add(key);
        if (statusOf(exc) === 'cancelled') continue;
        const x = new ICAL.Event(exc);
        o = occurrenceFrom(exc, x.startDate, x.endDate, w.tz, key, true);
      } else {
        const e = n.clone();
        e.addDuration(duration);
        o = occurrenceFrom(comp, n, e, w.tz, key, true);
      }
      if (overlaps(o, w)) out.push(o);
    }
  }
  // Exceptions moved into the window from outside it, and lone instances whose series isn't stored.
  for (const [key, exc] of exceptions) {
    if (used.has(key) || statusOf(exc) === 'cancelled') continue;
    if (masters.length && !moved(exc)) continue;
    const x = new ICAL.Event(exc);
    const o = occurrenceFrom(exc, x.startDate, x.endDate, w.tz, key, masters.length > 0);
    if (overlaps(o, w)) out.push(o);
  }
  return out;
}

function moved(exc: Component): boolean {
  const rid = exc.getFirstPropertyValue('recurrence-id') as Time;
  return ridKey(rid) !== ridKey(exc.getFirstPropertyValue('dtstart') as Time);
}

/** The series (or single event) behind an object group, for the edit form. */
export function seriesInfo(icsList: string[], fallbackTz: string): SeriesInfo | null {
  for (const ics of icsList) {
    for (const comp of parseIcs(ics).getAllSubcomponents('vevent')) {
      if (comp.hasProperty('recurrence-id') || !comp.hasProperty('dtstart')) continue;
      const ev = new ICAL.Event(comp);
      const o = occurrenceFrom(comp, ev.startDate, ev.endDate, fallbackTz, null, false);
      const rule = comp.getFirstPropertyValue('rrule') as InstanceType<typeof ICAL.Recur> | null;
      return { summary: o.summary, location: o.location, description: o.description, allDay: o.allDay, start: o.start, end: o.end, rrule: rule ? rule.toString() : null };
    }
  }
  return null;
}

/* ---------- writing ---------- */

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

function parseWall(s: string, allDay: boolean): Wall {
  const m = WALL_RE.exec(s);
  if (!m || allDay !== !m[4]) throw badRequest(allDay ? 'All-day events need dates like 2026-01-31' : 'Times look like 2026-01-31T09:30');
  return { year: +m[1], month: +m[2], day: +m[3], hour: +(m[4] ?? 0), minute: +(m[5] ?? 0), second: 0 };
}

export function validateFields(f: EventFields): void {
  if (!f.allDay && !isIanaZone(f.timeZone)) throw badRequest(`Unknown time zone ${f.timeZone}`);
  const s = parseWall(f.start, f.allDay);
  const e = parseWall(f.end, f.allDay);
  const sm = f.allDay ? Date.UTC(s.year, s.month - 1, s.day) : zonedToUtc(s, f.timeZone);
  const em = f.allDay ? Date.UTC(e.year, e.month - 1, e.day) : zonedToUtc(e, f.timeZone);
  if (f.allDay ? em <= sm : em < sm) throw badRequest('The event ends before it starts');
  if (f.rrule !== null) {
    const parts = f.rrule.split(';');
    if (!parts.every((p) => /^[A-Z-]+=[A-Za-z0-9,+:-]+$/.test(p)) || !parts.some((p) => /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(p))) {
      throw badRequest('Invalid repeat rule');
    }
    try {
      ICAL.Recur.fromString(f.rrule);
    } catch {
      throw badRequest('Invalid repeat rule');
    }
  }
}

/** Start and end of an edit as instants (all-day as UTC midnight), for drivers that don't speak iCalendar. */
export function fieldInstants(f: EventFields): { start: number; end: number } {
  const s = parseWall(f.start, f.allDay);
  const e = parseWall(f.end, f.allDay);
  if (f.allDay) return { start: Date.UTC(s.year, s.month - 1, s.day), end: Date.UTC(e.year, e.month - 1, e.day) };
  return { start: zonedToUtc(s, f.timeZone), end: zonedToUtc(e, f.timeZone) };
}

function ensureZone(root: Component, tz: string) {
  if (tz === 'UTC') return;
  if (root.getAllSubcomponents('vtimezone').some((z) => textOf(z, 'tzid') === tz)) return;
  root.addSubcomponent(new ICAL.Component(ICAL.parse(vtimezone(tz))));
}

function setTime(root: Component, comp: Component, name: string, wallStr: string, allDay: boolean, tz: string) {
  const w = parseWall(wallStr, allDay);
  comp.removeAllProperties(name);
  const prop = new ICAL.Property(name, comp);
  if (allDay) {
    prop.resetType('date');
    prop.setValue(ICAL.Time.fromData({ year: w.year, month: w.month, day: w.day, isDate: true }));
  } else if (tz === 'UTC') {
    prop.setValue(ICAL.Time.fromData({ ...w, isDate: false }, ICAL.Timezone.utcTimezone));
  } else {
    ensureZone(root, tz);
    prop.setParameter('tzid', tz);
    prop.setValue(ICAL.Time.fromData({ ...w, isDate: false }));
  }
  comp.addProperty(prop);
}

function setText(comp: Component, name: string, value: string) {
  comp.removeAllProperties(name);
  if (value) comp.addPropertyWithValue(name, value);
}

function touch(comp: Component) {
  const now = ICAL.Time.fromJSDate(new Date(), true);
  comp.updatePropertyWithValue('dtstamp', now);
  comp.updatePropertyWithValue('last-modified', now);
  const seq = Number(comp.getFirstPropertyValue('sequence') ?? -1);
  comp.updatePropertyWithValue('sequence', Number.isFinite(seq) ? seq + 1 : 0);
}

function applyFields(root: Component, comp: Component, f: EventFields, withRule: boolean) {
  setText(comp, 'summary', f.summary);
  setText(comp, 'location', f.location);
  setText(comp, 'description', f.description);
  setTime(root, comp, 'dtstart', f.start, f.allDay, f.timeZone);
  comp.removeAllProperties('duration');
  setTime(root, comp, 'dtend', f.end, f.allDay, f.timeZone);
  if (withRule) {
    comp.removeAllProperties('rrule');
    if (f.rrule) comp.addPropertyWithValue('rrule', ICAL.Recur.fromString(f.rrule));
  }
  touch(comp);
}

export const newUid = () => `${crypto.randomUUID()}@homemail`;

export function newObject(uid: string, f: EventFields): string {
  const root = emptyCalendar();
  const ev = new ICAL.Component('vevent');
  ev.addPropertyWithValue('uid', uid);
  ev.addPropertyWithValue('created', ICAL.Time.fromJSDate(new Date(), true));
  root.addSubcomponent(ev);
  applyFields(root, ev, f, true);
  ev.updatePropertyWithValue('sequence', 0);
  return root.toString();
}

function findMaster(root: Component): Component | null {
  return root.getAllSubcomponents('vevent').find((c) => !c.hasProperty('recurrence-id')) ?? null;
}

function findException(root: Component, key: string): Component | null {
  return root.getAllSubcomponents('vevent').find((c) => c.hasProperty('recurrence-id') && ridKey(c.getFirstPropertyValue('recurrence-id') as Time) === key) ?? null;
}

/** A RECURRENCE-ID or EXDATE value for an occurrence, written the way the series writes DTSTART. */
function ridProperty(name: string, master: Component, key: string): InstanceType<typeof ICAL.Property> {
  const startProp = master.getFirstProperty('dtstart')!;
  const start = startProp.getFirstValue() as Time;
  const prop = new ICAL.Property(name, master);
  let t: Time;
  if (start.isDate) {
    prop.resetType('date');
    t = ICAL.Time.fromDateString(key.slice(0, 10));
  } else if (key.endsWith('Z')) {
    t = ICAL.Time.fromDateTimeString(key.slice(0, 19) + 'Z');
    if (!isUtc(start) && !isFloating(start)) {
      t = t.convertToZone(start.zone!);
      prop.setParameter('tzid', String(startProp.getParameter('tzid') ?? start.zone!.tzid));
    }
  } else {
    t = ICAL.Time.fromDateTimeString(key);
  }
  prop.setValue(t);
  return prop;
}

function dropExceptions(root: Component, master: Component) {
  for (const c of root.getAllSubcomponents('vevent')) if (c !== master && c.hasProperty('recurrence-id')) root.removeSubcomponent(c);
  master.removeAllProperties('exdate');
  master.removeAllProperties('rdate');
}

/**
 * Applies an edit to a stored object. With a recurrenceId and scope
 * "occurrence", only that occurrence changes (becoming an exception).
 */
export function editObject(ics: string, f: EventFields, scope: 'series' | 'occurrence', recurrenceId: string | null): string {
  const root = parseIcs(ics);
  const master = findMaster(root);
  if (scope === 'occurrence' && recurrenceId) {
    let exc = findException(root, recurrenceId);
    if (!exc) {
      if (!master) throw badRequest('That occurrence no longer exists');
      exc = new ICAL.Component(structuredClone(master.toJSON()));
      for (const p of ['rrule', 'rdate', 'exdate', 'recurrence-id']) exc.removeAllProperties(p);
      exc.addProperty(ridProperty('recurrence-id', master, recurrenceId));
      root.addSubcomponent(exc);
    }
    applyFields(root, exc, f, false);
    return root.toString();
  }
  const target = master ?? root.getFirstSubcomponent('vevent');
  if (!target) throw badRequest('This event has no data');
  const before = seriesSignature(target);
  applyFields(root, target, f, !!master);
  // Like Outlook: changing the series' timing or pattern discards per-occurrence changes.
  if (master && (before !== seriesSignature(target) || !f.rrule)) dropExceptions(root, master);
  return root.toString();
}

const seriesSignature = (c: Component) => ['dtstart', 'dtend', 'rrule'].map((p) => c.getFirstProperty(p)?.toICALString() ?? '').join('|');

/** Removes one occurrence from a series. Returns null when nothing would be left. */
export function deleteOccurrence(ics: string, recurrenceId: string): string | null {
  const root = parseIcs(ics);
  const exc = findException(root, recurrenceId);
  if (exc) root.removeSubcomponent(exc);
  const master = findMaster(root);
  if (master) {
    master.addProperty(ridProperty('exdate', master, recurrenceId));
    touch(master);
  }
  return root.getAllSubcomponents('vevent').length ? root.toString() : null;
}

/** A VCALENDAR wrapping one standalone event, for providers that hand us JSON. */
export interface PlainEvent {
  uid: string;
  summary: string;
  location: string;
  description: string;
  status: Occurrence['status'];
  /** All-day: "YYYY-MM-DD". Timed: UTC ms. */
  start: string | number;
  end: string | number;
  /** Zone to write timed values in, if known; otherwise UTC. */
  timeZone?: string;
  rrule?: string[];
  recurrenceId?: string | number;
}

function plainTime(prop: string, v: string | number, tz: string | undefined): string {
  if (typeof v === 'string') return `${prop};VALUE=DATE:${v.replaceAll('-', '')}`;
  if (tz && tz !== 'UTC' && isIanaZone(tz)) {
    const w = utcToWall(v, tz);
    return `${prop};TZID=${tz}:${pad(w.year, 4)}${pad(w.month)}${pad(w.day)}T${pad(w.hour)}${pad(w.minute)}${pad(w.second)}`;
  }
  return `${prop}:${new Date(v).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
}

const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

export function plainToIcs(e: PlainEvent): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HomeMail//Calendar//EN', 'BEGIN:VEVENT', `UID:${escapeText(e.uid)}`];
  if (e.summary) lines.push(`SUMMARY:${escapeText(e.summary)}`);
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  lines.push(`STATUS:${e.status.toUpperCase()}`);
  lines.push(plainTime('DTSTART', e.start, e.timeZone), plainTime('DTEND', e.end, e.timeZone));
  if (e.recurrenceId !== undefined) lines.push(plainTime('RECURRENCE-ID', e.recurrenceId, e.timeZone));
  for (const r of e.rrule ?? []) if (/^(RRULE|EXRULE|RDATE|EXDATE)[:;]/i.test(r)) lines.push(r);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}
