import ICAL from 'ical.js';

/**
 * Time zone helpers built on the IANA database that ships with Node (Intl).
 *
 * iCalendar data names zones with TZID and is supposed to carry a VTIMEZONE
 * definition for each, but plenty of it doesn't (Google, Exchange, hand-written
 * feeds). We generate VTIMEZONE definitions from Intl so ical.js can treat
 * those times as zoned rather than floating, and so the events we write carry
 * proper definitions.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const validCache = new Map<string, boolean>();
export function isIanaZone(tz: string): boolean {
  let ok = validCache.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      ok = tz.length > 0;
    } catch {
      ok = false;
    }
    validCache.set(tz, ok);
  }
  return ok;
}

/** Windows zone names that Outlook and Exchange put in TZID. */
const WINDOWS_ZONES: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Canada Central Standard Time': 'America/Regina',
  'Central America Standard Time': 'America/Guatemala',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'Mexico Standard Time': 'America/Mexico_City',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'UTC': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Egypt Standard Time': 'Africa/Cairo',
  'Arabian Standard Time': 'Asia/Dubai',
  'Arab Standard Time': 'Asia/Riyadh',
  'Iran Standard Time': 'Asia/Tehran',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Taipei Standard Time': 'Asia/Taipei',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'W. Australia Standard Time': 'Australia/Perth',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Tasmania Standard Time': 'Australia/Hobart',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

const IANA_TO_WINDOWS = new Map<string, string>();
for (const [win, iana] of Object.entries(WINDOWS_ZONES)) if (!IANA_TO_WINDOWS.has(iana)) IANA_TO_WINDOWS.set(iana, win);

/** The Windows name for an IANA zone, for APIs (Microsoft Graph) that prefer those. */
export function windowsZoneFor(iana: string): string | undefined {
  return IANA_TO_WINDOWS.get(iana);
}

/** Maps a TZID as found in the wild to an IANA zone, or undefined if it can't. */
export function ianaFor(tzid: string | undefined | null): string | undefined {
  if (!tzid) return undefined;
  const t = tzid.trim().replace(/^"|"$/g, '');
  if (isIanaZone(t)) return t;
  if (WINDOWS_ZONES[t]) return WINDOWS_ZONES[t];
  // Mozilla-style prefixes, e.g. "/mozilla.org/20050126_1/America/New_York".
  const m = /([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_]+)?)$/.exec(t);
  if (m && isIanaZone(m[1])) return m[1];
  return undefined;
}

/** Offset of `tz` from UTC at the instant `ms`, in minutes. */
export function offsetMinutes(ms: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** UTC instant of a wall-clock time in `tz`. Times skipped by a DST jump move forward. */
export function zonedToUtc(w: Wall, tz: string): number {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let t = naive - offsetMinutes(naive, tz) * 60000;
  const second = naive - offsetMinutes(t, tz) * 60000;
  if (second !== t) t = Math.max(t, second);
  return t;
}

export function utcToWall(ms: number, tz: string): Wall {
  const d = new Date(ms + offsetMinutes(ms, tz) * 60000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const icsOffset = (min: number) => `${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}${pad(Math.abs(min) % 60)}`;

interface Transition {
  at: number;
  from: number;
  to: number;
}

/** DST transitions of `tz` during `year`, found by scanning days then bisecting to the minute. */
function transitions(tz: string, year: number): Transition[] {
  const out: Transition[] = [];
  let t = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  let off = offsetMinutes(t, tz);
  while (t < end) {
    const next = t + 86400_000;
    const nextOff = offsetMinutes(next, tz);
    if (nextOff !== off) {
      let lo = t;
      let hi = next;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
        if (offsetMinutes(mid, tz) === off) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, from: off, to: nextOff });
      off = nextOff;
    }
    t = next;
  }
  return out;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** A STANDARD/DAYLIGHT block repeating yearly on the weekday rule a transition falls on. */
function observance(kind: 'STANDARD' | 'DAYLIGHT', tr: Transition): string {
  const w = new Date(tr.at + tr.from * 60000);
  const month = w.getUTCMonth() + 1;
  const day = w.getUTCDate();
  const dow = w.getUTCDay();
  const daysInMonth = new Date(Date.UTC(w.getUTCFullYear(), month, 0)).getUTCDate();
  const nth = day + 7 > daysInMonth ? -1 : Math.ceil(day / 7);
  // DTSTART should itself match the rule, so find that weekday in 1970.
  let d1970: number;
  if (nth === -1) {
    const last = new Date(Date.UTC(1970, month, 0));
    d1970 = last.getUTCDate() - ((last.getUTCDay() - dow + 7) % 7);
  } else {
    const first = new Date(Date.UTC(1970, month - 1, 1)).getUTCDay();
    d1970 = 1 + ((dow - first + 7) % 7) + (nth - 1) * 7;
  }
  return [
    `BEGIN:${kind}`,
    `DTSTART:1970${pad(month)}${pad(d1970)}T${pad(w.getUTCHours())}${pad(w.getUTCMinutes())}00`,
    `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${nth}${DAYS[dow]}`,
    `TZOFFSETFROM:${icsOffset(tr.from)}`,
    `TZOFFSETTO:${icsOffset(tr.to)}`,
    `END:${kind}`,
  ].join('\r\n');
}

const vtzCache = new Map<string, string>();

/** A VTIMEZONE block for an IANA zone, using this year's rules. */
export function vtimezone(tz: string, tzid = tz): string {
  const key = `${tz}\0${tzid}`;
  let out = vtzCache.get(key);
  if (out) return out;
  const year = new Date().getUTCFullYear();
  const trs = transitions(tz, year);
  const parts = [`BEGIN:VTIMEZONE`, `TZID:${tzid}`];
  if (trs.length >= 2) {
    for (const tr of trs.slice(0, 2)) parts.push(observance(tr.to > tr.from ? 'DAYLIGHT' : 'STANDARD', tr));
  } else {
    // No DST this year (any one-off change becomes the fixed offset).
    const off = offsetMinutes(Date.UTC(year, 6, 1), tz);
    parts.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${icsOffset(off)}`, `TZOFFSETTO:${icsOffset(off)}`, 'END:STANDARD');
  }
  parts.push('END:VTIMEZONE');
  out = parts.join('\r\n');
  vtzCache.set(key, out);
  return out;
}

/**
 * Makes ical.js aware of every TZID used in `ics` that it can't resolve from
 * the data itself, so those times aren't treated as floating.
 */
export function registerZones(ics: string): void {
  for (const m of ics.matchAll(/TZID=("[^"]*"|[^:;\r\n]*)/g)) {
    const tzid = m[1].replace(/^"|"$/g, '');
    if (ICAL.TimezoneService.has(tzid)) continue;
    const iana = ianaFor(tzid);
    if (!iana || iana === 'UTC') continue;
    const comp = new ICAL.Component(ICAL.parse(vtimezone(iana, tzid)));
    ICAL.TimezoneService.register(new ICAL.Timezone(comp), tzid);
  }
}
