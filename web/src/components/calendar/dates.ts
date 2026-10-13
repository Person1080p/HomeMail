import type { CalEvent } from '../../types';

export const DAY_MS = 86400_000;
export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local date as "YYYY-MM-DD". */
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Local time as "HH:mm". */
export const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** Local midnight of a "YYYY-MM-DD" date. */
export const parseYmd = (s: string) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

export function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

export function addMonths(d: Date, n: number): Date {
  const c = new Date(d.getFullYear(), d.getMonth() + n, 1);
  c.setDate(Math.min(d.getDate(), new Date(c.getFullYear(), c.getMonth() + 1, 0).getDate()));
  return c;
}

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 0 = Sunday … 6 = Saturday, from the browser's locale. */
export function weekStartDay(): number {
  try {
    const loc = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
    const region = loc.maximize().region ?? '';
    // Where Intl can't say: Sunday in the Americas and parts of Asia, Monday elsewhere.
    return ['US', 'CA', 'MX', 'BR', 'JP', 'KR', 'TW', 'HK', 'IL', 'PH', 'IN', 'ZA', 'AU'].includes(region) ? 0 : 1;
  } catch {
    return 0;
  }
}

export function startOfWeek(d: Date, first: number): Date {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() - first + 7) % 7));
}

export type ViewKind = 'day' | 'workweek' | 'week' | 'month';

/** The days a view shows, as [first day, day after the last). */
export function viewRange(view: ViewKind, anchor: Date, first: number): { start: Date; end: Date; days: number } {
  if (view === 'day') return { start: startOfDay(anchor), end: addDays(startOfDay(anchor), 1), days: 1 };
  if (view === 'workweek') {
    const mon = startOfWeek(anchor, 1);
    return { start: mon, end: addDays(mon, 5), days: 5 };
  }
  if (view === 'week') {
    const s = startOfWeek(anchor, first);
    return { start: s, end: addDays(s, 7), days: 7 };
  }
  const s = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1), first);
  return { start: s, end: addDays(s, 42), days: 42 };
}

export function stepAnchor(view: ViewKind, anchor: Date, dir: -1 | 1): Date {
  if (view === 'day') return addDays(anchor, dir);
  if (view === 'month') return addMonths(anchor, dir);
  return addDays(anchor, 7 * dir);
}

export function rangeTitle(view: ViewKind, start: Date, end: Date, anchor: Date): string {
  if (view === 'month') return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  if (view === 'day') return anchor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).formatRange(start, addDays(end, -1));
}

export const timeLabel = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Start and end of an event as local Dates (all-day: local midnights, end exclusive). */
export function eventBounds(e: CalEvent): { start: Date; end: Date } {
  if (e.allDay) return { start: parseYmd(e.start), end: parseYmd(e.end) };
  return { start: new Date(e.start), end: new Date(e.end) };
}

/** Events shown as bars across days: all-day ones and timed ones lasting a day or more. */
export const isSpanning = (e: CalEvent) => {
  if (e.allDay) return true;
  const { start, end } = eventBounds(e);
  return end.getTime() - start.getTime() >= DAY_MS && !sameDay(start, end);
};

export function whenText(e: CalEvent): string {
  const { start, end } = eventBounds(e);
  const dateOpts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric', ...(start.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) };
  if (e.allDay) {
    const last = addDays(end, -1);
    return sameDay(start, last) ? `${start.toLocaleDateString(undefined, dateOpts)} · All day` : `${start.toLocaleDateString(undefined, dateOpts)} – ${last.toLocaleDateString(undefined, dateOpts)}`;
  }
  if (sameDay(start, end) || end.getTime() - start.getTime() <= 0) return `${start.toLocaleDateString(undefined, dateOpts)} · ${timeLabel(start)} – ${timeLabel(end)}`;
  return `${start.toLocaleDateString(undefined, dateOpts)} ${timeLabel(start)} – ${end.toLocaleDateString(undefined, dateOpts)} ${timeLabel(end)}`;
}

/* ---------- layout ---------- */

export interface SpanItem {
  event: CalEvent;
  /** Column of the first visible day and how many days it covers. */
  col: number;
  span: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** Lays events out as bars across `days` columns starting at `start`, each in the first free lane. */
export function layoutSpans(events: CalEvent[], start: Date, days: number): SpanItem[] {
  const end = addDays(start, days);
  const items: SpanItem[] = [];
  const sorted = [...events].sort((a, b) => {
    const A = eventBounds(a);
    const B = eventBounds(b);
    return A.start.getTime() - B.start.getTime() || B.end.getTime() - B.start.getTime() - (A.end.getTime() - A.start.getTime());
  });
  const lanes: number[][] = [];
  for (const event of sorted) {
    const b = eventBounds(event);
    if (b.end <= start || b.start >= end) continue;
    const from = b.start < start ? start : startOfDay(b.start);
    // A timed event ending at midnight doesn't show on the next day.
    const lastDay = event.allDay ? addDays(b.end, -1) : startOfDay(new Date(Math.max(b.start.getTime(), b.end.getTime() - 1)));
    const to = lastDay >= end ? addDays(end, -1) : lastDay;
    const col = Math.round((startOfDay(from).getTime() - start.getTime()) / DAY_MS);
    const span = Math.max(1, Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS) + 1);
    let lane = 0;
    while (lanes[lane]?.some((c) => c >= col && c < col + span)) lane++;
    (lanes[lane] ??= []).push(...Array.from({ length: span }, (_, i) => col + i));
    items.push({ event, col, span, lane, continuesBefore: b.start < start, continuesAfter: lastDay >= end });
  }
  return items;
}

export interface TimedItem {
  event: CalEvent;
  /** Minutes from midnight of the day shown. */
  top: number;
  bottom: number;
  column: number;
  columns: number;
}

/** Timed events within one day, side by side where they overlap. */
export function layoutDay(events: CalEvent[], day: Date): TimedItem[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();
  const items = events
    .map((event) => {
      const b = eventBounds(event);
      const s = Math.max(b.start.getTime(), dayStart);
      const e = Math.min(Math.max(b.end.getTime(), b.start.getTime() + 15 * 60_000), dayEnd);
      return { event, top: (s - dayStart) / 60_000, bottom: (e - dayStart) / 60_000, column: 0, columns: 1 };
    })
    .filter((i) => i.bottom > 0 && i.top < 1440)
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  // Clusters of transitively overlapping events share a column count.
  let cluster: TimedItem[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols: number[] = [];
    for (const it of cluster) {
      let c = cols.findIndex((end) => end <= it.top);
      if (c === -1) c = cols.length;
      cols[c] = Math.max(it.bottom, it.top + 20);
      it.column = c;
    }
    for (const it of cluster) it.columns = cols.length;
    cluster = [];
  };
  for (const it of items) {
    if (it.top >= clusterEnd && cluster.length) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.bottom, it.top + 20);
  }
  if (cluster.length) flush();
  return items;
}

/* ---------- repeat rules ---------- */

export type RepeatKind = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthlyDay' | 'monthlyNth' | 'yearly' | 'custom';
export interface RepeatEnd {
  type: 'never' | 'until' | 'count';
  until: string;
  count: number;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const nthOf = (d: Date) => {
  const n = Math.ceil(d.getDate() / 7);
  return n > 4 ? -1 : n;
};

export function buildRrule(kind: RepeatKind, start: Date, end: RepeatEnd, allDay: boolean, custom: string | null): string | null {
  let base: string;
  switch (kind) {
    case 'none':
      return null;
    case 'custom':
      return custom;
    case 'daily':
      base = 'FREQ=DAILY';
      break;
    case 'weekdays':
      base = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
      break;
    case 'weekly':
      base = `FREQ=WEEKLY;BYDAY=${DAYS[start.getDay()]}`;
      break;
    case 'monthlyDay':
      base = `FREQ=MONTHLY;BYMONTHDAY=${start.getDate()}`;
      break;
    case 'monthlyNth':
      base = `FREQ=MONTHLY;BYDAY=${nthOf(start)}${DAYS[start.getDay()]}`;
      break;
    case 'yearly':
      base = `FREQ=YEARLY;BYMONTH=${start.getMonth() + 1};BYMONTHDAY=${start.getDate()}`;
      break;
  }
  if (end.type === 'count' && end.count > 0) return `${base};COUNT=${Math.min(999, Math.floor(end.count))}`;
  if (end.type === 'until' && end.until) {
    // UNTIL is a date for all-day series and a UTC time (end of that local day) otherwise.
    if (allDay) return `${base};UNTIL=${end.until.replaceAll('-', '')}`;
    const last = new Date(parseYmd(end.until).getTime() + DAY_MS - 1000);
    return `${base};UNTIL=${last.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
  }
  return base;
}

/** Recognises the rules the repeat menu can make; anything else is "custom" and kept as it is. */
export function parseRrule(rrule: string | null, start: Date): { kind: RepeatKind; end: RepeatEnd } {
  const end: RepeatEnd = { type: 'never', until: ymd(addMonths(start, 3)), count: 10 };
  if (!rrule) return { kind: 'none', end };
  const parts = new Map(rrule.split(';').map((p) => p.split('=') as [string, string]));
  if (parts.has('COUNT')) Object.assign(end, { type: 'count', count: Number(parts.get('COUNT')) });
  const until = parts.get('UNTIL');
  if (until) {
    const d = until.length > 8 ? new Date(`${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}T${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}Z`) : parseYmd(`${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`);
    Object.assign(end, { type: 'until', until: ymd(d) });
  }
  for (const k of ['COUNT', 'UNTIL', 'WKST']) parts.delete(k);
  if (parts.get('INTERVAL') === '1') parts.delete('INTERVAL');
  const rest = [...parts].map(([k, v]) => `${k}=${v}`).sort().join(';');
  const candidates: RepeatKind[] = ['daily', 'weekdays', 'weekly', 'monthlyDay', 'monthlyNth', 'yearly'];
  for (const kind of candidates) {
    const built = buildRrule(kind, start, { type: 'never', until: '', count: 0 }, false, null)!;
    if (built.split(';').sort().join(';') === rest) return { kind, end };
  }
  // Plain FREQ rules repeat on the start's own day, the same as the menu's choices.
  const plain: Record<string, RepeatKind> = { 'FREQ=DAILY': 'daily', 'FREQ=WEEKLY': 'weekly', 'FREQ=MONTHLY': 'monthlyDay', 'FREQ=YEARLY': 'yearly' };
  if (plain[rest]) return { kind: plain[rest], end };
  return { kind: 'custom', end };
}

const ORD = ['', 'first', 'second', 'third', 'fourth'];

export function repeatLabel(kind: RepeatKind, start: Date): string {
  const weekday = start.toLocaleDateString(undefined, { weekday: 'long' });
  switch (kind) {
    case 'none':
      return 'Does not repeat';
    case 'daily':
      return 'Every day';
    case 'weekdays':
      return 'Every weekday (Monday to Friday)';
    case 'weekly':
      return `Every week on ${weekday}`;
    case 'monthlyDay':
      return `Every month on day ${start.getDate()}`;
    case 'monthlyNth': {
      const n = nthOf(start);
      return `Every month on the ${n === -1 ? 'last' : ORD[n]} ${weekday}`;
    }
    case 'yearly':
      return `Every year on ${start.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`;
    case 'custom':
      return 'Custom (kept as it is)';
  }
}

/** One line describing a series, for the event details. */
export function describeRrule(rrule: string | null, start: Date): string {
  if (!rrule) return '';
  const { kind, end } = parseRrule(rrule, start);
  const interval = Number(/INTERVAL=(\d+)/.exec(rrule)?.[1] ?? 1);
  let text = kind === 'custom' ? (interval > 1 ? `Repeats every ${interval} ${({ DAILY: 'days', WEEKLY: 'weeks', MONTHLY: 'months', YEARLY: 'years' } as Record<string, string>)[/FREQ=(\w+)/.exec(rrule)?.[1] ?? ''] ?? 'periods'}` : 'Repeats') : repeatLabel(kind, start);
  if (end.type === 'count') text += `, ${end.count} times`;
  if (end.type === 'until') text += `, until ${parseYmd(end.until).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return text;
}
