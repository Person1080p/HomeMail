import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { api, qs } from '../../api';
import { useApp } from '../../context';
import { onEvent } from '../../events';
import type { CalEvent, CalendarInfo, CalendarState, SeriesInfo } from '../../types';
import { Icon } from '../Icon';
import { ContextMenu, Spinner, useAction, useLocalStorage, type MenuEntry } from '../ui';
import {
  type ViewKind,
  addDays,
  addMonths,
  eventBounds,
  isSpanning,
  layoutDay,
  layoutSpans,
  rangeTitle,
  sameDay,
  startOfDay,
  startOfWeek,
  stepAnchor,
  timeLabel,
  timeZone,
  viewRange,
  weekStartDay,
  ymd,
} from './dates';
import { type EditorRequest, type Scope, EventDetails, EventEditor, draftFor, draftFromEvent, draftFromSeries } from './EventDialogs';

const HOUR = 48;
const VIEWS: { id: ViewKind; label: string; key: string }[] = [
  { id: 'day', label: 'Day', key: 'd' },
  { id: 'workweek', label: 'Work week', key: 'x' },
  { id: 'week', label: 'Week', key: 'w' },
  { id: 'month', label: 'Month', key: 'm' },
];
const COLORS: [string, string][] = [
  ['#2f6fde', 'Blue'],
  ['#d13438', 'Red'],
  ['#107c10', 'Green'],
  ['#ca5010', 'Orange'],
  ['#8764b8', 'Purple'],
  ['#038387', 'Teal'],
  ['#c239b3', 'Pink'],
  ['#986f0b', 'Brown'],
  ['#4f6bed', 'Indigo'],
  ['#567c73', 'Sage'],
];

type MenuState = { x: number; y: number; entries: MenuEntry[] };

export function CalendarView({ active }: { active: boolean }) {
  const { navigate } = useApp();
  const run = useAction();
  const [state, setState] = useState<CalendarState | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [view, setView] = useLocalStorage<ViewKind>('homemail.calendar.view', 'week');
  const [defaultCal, setDefaultCal] = useLocalStorage<number | null>('homemail.calendar.default', null);
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [details, setDetails] = useState<CalEvent | null>(null);
  const [editor, setEditor] = useState<EditorRequest | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const first = useMemo(weekStartDay, []);
  const range = useMemo(() => viewRange(view, anchor, first), [view, anchor, first]);
  const seq = useRef(0);

  const calendars = useMemo(() => state?.calendars ?? [], [state]);
  const byId = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars]);
  const visibleKey = calendars
    .filter((c) => c.visible)
    .map((c) => c.id)
    .join(',');

  const loadState = useCallback(async () => setState(await api<CalendarState>('GET', '/calendar')), []);
  const loadEvents = useCallback(async () => {
    const mine = ++seq.current;
    const list = await api<CalEvent[]>('GET', `/calendar/events?${qs({ from: ymd(range.start), to: ymd(range.end), tz: timeZone() })}`);
    if (mine === seq.current) setEvents(list);
  }, [range.start, range.end]);

  useEffect(() => {
    if (active) loadState().catch(() => {});
  }, [active, loadState]);

  useEffect(() => {
    if (active && state) run(loadEvents);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loadEvents, visibleKey, !!state]);

  // Syncs finishing on the server (or edits in another tab) arrive as events; coalesce bursts.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent('calendar.changed', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        loadState().catch(() => {});
        loadEvents().catch(() => {});
      }, 300);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [loadState, loadEvents]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const refresh = async () => {
    setSyncing(true);
    await run(async () => setState(await api<CalendarState>('POST', '/calendar/sync')));
    await run(loadEvents);
    setSyncing(false);
  };

  const writableCals = calendars.filter((c) => !c.readOnly);
  const targetCalendar = (preferred?: number) =>
    writableCals.find((c) => c.id === preferred) ?? writableCals.find((c) => c.id === defaultCal) ?? writableCals.find((c) => c.isDefault && c.visible) ?? writableCals[0];

  const newEvent = (start: Date, end: Date, allDay: boolean, calendarId?: number) => {
    const cal = targetCalendar(calendarId);
    if (!cal) return run(async () => Promise.reject(new Error('No calendar you can add events to')));
    setEditor({ draft: draftFor(start, end, allDay), calendarId: cal.id, scope: 'series' });
  };

  const newEventNow = () => {
    const base = sameDay(anchor, new Date()) ? new Date() : new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 9);
    const start = new Date(base);
    start.setMinutes(base.getMinutes() < 30 && sameDay(anchor, new Date()) ? 30 : 0, 0, 0);
    if (sameDay(anchor, new Date()) && base.getMinutes() >= 30) start.setHours(base.getHours() + 1);
    newEvent(start, new Date(start.getTime() + 3600_000), false);
  };

  const edit = async (e: CalEvent, scope: Scope) => {
    setDetails(null);
    if (scope === 'series' && e.recurring) {
      const s = await run(() => api<SeriesInfo>('GET', `/calendar/calendars/${e.calendarId}/series?${qs({ uid: e.uid, tz: timeZone() })}`));
      if (s) setEditor({ draft: draftFromSeries(s), calendarId: e.calendarId, event: e, scope });
    } else {
      setEditor({ draft: draftFromEvent(e), calendarId: e.calendarId, event: e, scope });
    }
  };

  const remove = async (e: CalEvent, scope: Scope) => {
    const what = e.recurring ? (scope === 'series' ? `every occurrence of "${e.summary}"` : `this occurrence of "${e.summary}"`) : `"${e.summary || '(no title)'}"`;
    if (!confirm(`Delete ${what}?`)) return;
    setDetails(null);
    const ok = await run(() => api('DELETE', `/calendar/calendars/${e.calendarId}/events`, { uid: e.uid, recurrenceId: e.recurrenceId, scope }), 'Event deleted');
    if (ok !== undefined) run(loadEvents);
  };

  const patchCalendar = async (c: CalendarInfo, body: Partial<Pick<CalendarInfo, 'visible' | 'color' | 'name'>>) => {
    const s = await run(() => api<CalendarState>('PATCH', `/calendar/calendars/${c.id}`, body));
    if (s) setState(s);
  };

  const eventMenu = (e: CalEvent, ev: ReactMouseEvent) => {
    ev.preventDefault();
    const cal = byId.get(e.calendarId);
    const ro = !cal || cal.readOnly;
    const entries: MenuEntry[] = [{ label: 'Open', icon: 'external', onSelect: () => setDetails(e) }];
    if (ro) entries.push('separator', { heading: 'Read-only calendar' });
    else if (e.recurring) {
      entries.push(
        { label: 'Edit occurrence', icon: 'pencil', onSelect: () => edit(e, 'occurrence') },
        { label: 'Edit series', icon: 'repeat', onSelect: () => edit(e, 'series') },
        'separator',
        { label: 'Delete occurrence', icon: 'trash', danger: true, onSelect: () => remove(e, 'occurrence') },
        { label: 'Delete series', icon: 'trash', danger: true, onSelect: () => remove(e, 'series') },
      );
    } else {
      entries.push({ label: 'Edit', icon: 'pencil', onSelect: () => edit(e, 'series') }, 'separator', { label: 'Delete', icon: 'trash', danger: true, shortcut: 'Del', onSelect: () => remove(e, 'series') });
    }
    setMenu({ x: ev.clientX, y: ev.clientY, entries });
  };

  const calendarMenu = (c: CalendarInfo, ev: ReactMouseEvent) => {
    ev.preventDefault();
    const source = state?.sources.find((s) => s.id === c.sourceId);
    const others = calendars.filter((x) => x.id !== c.id);
    const entries: MenuEntry[] = [
      { label: 'Show only this calendar', icon: 'eye', onSelect: () => showOnly(c) },
      ...(others.some((x) => !x.visible) ? [{ label: 'Show all calendars', icon: 'eye', onSelect: showAll }] : []),
      {
        label: 'Colour',
        icon: 'highlighter',
        submenu: COLORS.map(([hex, name]) => ({ label: name, icon: hex === c.color ? 'check' : undefined, onSelect: () => patchCalendar(c, { color: hex }) })),
      },
    ];
    if (!c.readOnly) {
      entries.push(
        'separator',
        { label: 'New event in this calendar', icon: 'plus', onSelect: () => newEvent(...defaultSlot(), false, c.id) },
        { label: defaultCal === c.id ? 'Default for new events ✓' : 'Use for new events', icon: 'star', onSelect: () => setDefaultCal(c.id) },
      );
    }
    if (source?.kind === 'local') {
      entries.push('separator', {
        label: 'Rename…',
        icon: 'pencil',
        onSelect: () => {
          const name = prompt('Calendar name', c.name)?.trim();
          if (name && name !== c.name) patchCalendar(c, { name });
        },
      });
      if (calendars.filter((x) => x.sourceId === c.sourceId).length > 1) {
        entries.push({
          label: 'Delete calendar',
          icon: 'trash',
          danger: true,
          onSelect: async () => {
            if (!confirm(`Delete "${c.name}" and all its events? This cannot be undone.`)) return;
            const s = await run(() => api<CalendarState>('DELETE', `/calendar/calendars/${c.id}`), 'Calendar deleted');
            if (s) setState(s);
          },
        });
      }
    } else if (source) {
      entries.push('separator', {
        label: 'Sync now',
        icon: 'refresh',
        onSelect: async () => {
          const s = await run(() => api<CalendarState>('POST', `/calendar/sources/${source.id}/sync`));
          if (s) setState(s);
        },
      });
      entries.push({ label: 'Account settings…', icon: 'settings', onSelect: () => navigate('/settings/calendars') });
    }
    setMenu({ x: ev.clientX, y: ev.clientY, entries });
  };

  const showOnly = async (c: CalendarInfo) => {
    for (const x of calendars) if (x.visible !== (x.id === c.id)) await patchCalendar(x, { visible: x.id === c.id });
  };
  const showAll = async () => {
    for (const x of calendars) if (!x.visible) await patchCalendar(x, { visible: true });
  };

  const defaultSlot = (): [Date, Date] => {
    const s = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 9);
    return [s, new Date(s.getTime() + 3600_000)];
  };

  const newCalendar = async () => {
    const name = prompt('Name of the new calendar')?.trim();
    if (!name) return;
    const s = await run(() => api<CalendarState>('POST', '/calendar/calendars', { name }));
    if (s) setState(s);
  };

  // Keyboard shortcuts while the calendar is showing and nothing else has focus.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || editor || details || menu) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
      const v = VIEWS.find((x) => x.key === e.key);
      if (v) setView(v.id);
      else if (e.key === 't') setAnchor(startOfDay(new Date()));
      else if (e.key === 'n') newEventNow();
      else if (e.key === 'ArrowLeft' || e.key === 'j') setAnchor((a) => stepAnchor(view, a, -1));
      else if (e.key === 'ArrowRight' || e.key === 'k') setAnchor((a) => stepAnchor(view, a, 1));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!state) return <Spinner label="Loading calendars…" />;

  const days = Array.from({ length: range.days }, (_, i) => addDays(range.start, i));
  const shown = events.filter((e) => byId.get(e.calendarId)?.visible);
  const errors = state.sources.filter((s) => s.lastError || !s.connected);

  return (
    <div className={`cal-app ${sidebarOpen ? 'show-sidebar' : ''}`}>
      <aside className="cal-sidebar">
        <div className="pane-head">
          <button className="btn btn-primary write-btn" onClick={newEventNow} title="New event (N)">
            <Icon name="plus" /> New event
          </button>
          <button className="icon-btn only-mobile" onClick={() => setSidebarOpen(false)} aria-label="Close calendar list">
            <Icon name="x" />
          </button>
        </div>
        <div className="cal-sidebar-body">
          <MiniMonth
            anchor={anchor}
            first={first}
            range={range}
            onPick={(d) => {
              setAnchor(d);
              setSidebarOpen(false);
            }}
          />
          {state.sources.map((src) => {
            const cals = calendars.filter((c) => c.sourceId === src.id);
            if (!cals.length && !src.lastError) return null;
            return (
              <section key={src.id} className="cal-group">
                <div className="cal-group-head" title={src.lastError ?? (src.lastSync ? `Synced ${new Date(src.lastSync).toLocaleString()}` : undefined)}>
                  <span className="ellipsis">{src.label}</span>
                  {src.syncing && <Icon name="refresh" size={12} className="spin" />}
                  {(src.lastError || !src.connected) && (
                    <button className="icon-btn icon-btn-sm warn-text" onClick={() => navigate('/settings/calendars')} aria-label={`Problem with ${src.label}`}>
                      <Icon name="alert" size={14} />
                    </button>
                  )}
                </div>
                <ul className="cal-list">
                  {cals.map((c) => (
                    <li key={c.id}>
                      <label className="cal-item" onContextMenu={(e) => calendarMenu(c, e)} title={c.readOnly ? `${c.name} (read-only)` : c.name}>
                        <input type="checkbox" checked={c.visible} onChange={() => patchCalendar(c, { visible: !c.visible })} style={{ accentColor: c.color }} />
                        <span className="cal-swatch" style={{ background: c.color }} aria-hidden="true" />
                        <span className="ellipsis">{c.name}</span>
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm cal-item-more"
                          aria-label={`Options for ${c.name}`}
                          onClick={(e) => {
                            e.preventDefault();
                            calendarMenu(c, e);
                          }}
                        >
                          <Icon name="more" size={14} />
                        </button>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          <div className="cal-sidebar-actions">
            <button className="link-btn" onClick={() => navigate('/settings/calendars?add=1')}>
              <Icon name="plus" size={14} /> Add calendar account
            </button>
            <button className="link-btn" onClick={newCalendar}>
              <Icon name="calendar" size={14} /> New calendar on this server
            </button>
          </div>
        </div>
      </aside>

      <section className="cal-main">
        <div className="pane-head cal-toolbar">
          <button className="icon-btn only-mobile" onClick={() => setSidebarOpen(true)} aria-label="Show calendars">
            <Icon name="menu" />
          </button>
          <button className="btn btn-sm" onClick={() => setAnchor(startOfDay(new Date()))} title="Today (T)">
            Today
          </button>
          <button className="icon-btn" onClick={() => setAnchor((a) => stepAnchor(view, a, -1))} aria-label="Previous" title="Previous (←)">
            <Icon name="chevronLeft" />
          </button>
          <button className="icon-btn" onClick={() => setAnchor((a) => stepAnchor(view, a, 1))} aria-label="Next" title="Next (→)">
            <Icon name="chevronRight" />
          </button>
          <h2 className="cal-title ellipsis">{rangeTitle(view, range.start, range.end, anchor)}</h2>
          <span className="spacer" />
          {errors.length > 0 && (
            <button className="btn btn-ghost btn-sm warn-text hide-mobile" onClick={() => navigate('/settings/calendars')} title={errors.map((s) => `${s.label}: ${s.lastError ?? 'needs to be signed in again'}`).join('\n')}>
              <Icon name="alert" size={14} /> {errors.length === 1 ? `${errors[0].label} isn't syncing` : `${errors.length} accounts aren't syncing`}
            </button>
          )}
          <div className="segmented hide-mobile" role="tablist" aria-label="View">
            {VIEWS.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? 'active' : ''} onClick={() => setView(v.id)} title={`${v.label} (${v.key.toUpperCase()})`}>
                {v.label}
              </button>
            ))}
          </div>
          <select className="only-mobile cal-view-select" value={view} onChange={(e) => setView(e.target.value as ViewKind)} aria-label="View">
            {VIEWS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          <button className="icon-btn" onClick={refresh} disabled={syncing} aria-label="Sync calendars" title="Sync calendars">
            <Icon name="refresh" className={syncing ? 'spin' : undefined} />
          </button>
        </div>
        {view === 'month' ? (
          <MonthGrid
            start={range.start}
            month={anchor.getMonth()}
            first={first}
            events={shown}
            calendars={byId}
            now={now}
            onCreate={(d) => newEvent(d, addDays(d, 1), true)}
            onOpen={setDetails}
            onMenu={eventMenu}
            onDay={(d) => {
              setAnchor(d);
              setView('day');
            }}
          />
        ) : (
          <TimeGrid
            key={view}
            days={days}
            events={shown}
            calendars={byId}
            now={now}
            onCreate={newEvent}
            onOpen={setDetails}
            onMenu={eventMenu}
            onDay={(d) => {
              setAnchor(d);
              setView('day');
            }}
          />
        )}
      </section>

      {details && <EventDetails event={details} calendar={byId.get(details.calendarId)} onClose={() => setDetails(null)} onEdit={(s) => edit(details, s)} onDelete={(s) => remove(details, s)} />}
      {editor && (
        <EventEditor
          request={editor}
          calendars={calendars}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            run(loadEvents);
          }}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}
    </div>
  );
}

/* ---------- mini month ---------- */

function MiniMonth({ anchor, first, range, onPick }: { anchor: Date; first: number; range: { start: Date; end: Date }; onPick: (d: Date) => void }) {
  const [month, setMonth] = useState(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  useEffect(() => setMonth(new Date(anchor.getFullYear(), anchor.getMonth(), 1)), [anchor]);
  const start = startOfWeek(month, first);
  const today = new Date();
  const names = Array.from({ length: 7 }, (_, i) => addDays(start, i).toLocaleDateString(undefined, { weekday: 'narrow' }));
  return (
    <div className="mini-month">
      <div className="mini-month-head">
        <strong>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
        <button className="icon-btn icon-btn-sm" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">
          <Icon name="chevronLeft" size={14} />
        </button>
        <button className="icon-btn icon-btn-sm" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
      <div className="mini-grid" role="grid">
        {names.map((n, i) => (
          <span key={`h${i}`} className="mini-dow" aria-hidden="true">
            {n}
          </span>
        ))}
        {Array.from({ length: 42 }, (_, i) => {
          const d = addDays(start, i);
          const inRange = d >= range.start && d < range.end;
          return (
            <button
              key={i}
              className={`mini-day ${d.getMonth() !== month.getMonth() ? 'other' : ''} ${sameDay(d, today) ? 'today' : ''} ${inRange ? 'in-range' : ''}`}
              onClick={() => onPick(d)}
              aria-label={d.toLocaleDateString(undefined, { dateStyle: 'full' })}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- day / week ---------- */

interface GridProps {
  events: CalEvent[];
  calendars: Map<number, CalendarInfo>;
  now: Date;
  onOpen: (e: CalEvent) => void;
  onMenu: (e: CalEvent, ev: ReactMouseEvent) => void;
  onDay: (d: Date) => void;
}

const colorVar = (calendars: Map<number, CalendarInfo>, e: CalEvent) => ({ ['--c' as string]: calendars.get(e.calendarId)?.color ?? '#888' });
const stateClass = (e: CalEvent) => (e.status === 'cancelled' ? 'cancelled' : e.status === 'tentative' ? 'tentative' : '');

function TimeGrid({ days, events, calendars, now, onCreate, onOpen, onMenu, onDay }: GridProps & { days: Date[]; onCreate: (s: Date, e: Date, allDay: boolean) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ day: number; a: number; b: number } | null>(null);
  const spans = useMemo(() => layoutSpans(events.filter(isSpanning), days[0], days.length), [events, days]);
  const timed = useMemo(() => events.filter((e) => !isSpanning(e)), [events]);
  const lanes = spans.reduce((n, s) => Math.max(n, s.lane + 1), 0);

  // Open at 7:00, or with the current time a third of the way down when showing today.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const n = new Date();
    const showsToday = days.some((d) => sameDay(d, n));
    const nowY = ((n.getHours() * 60 + n.getMinutes()) / 60) * HOUR;
    el.scrollTop = showsToday ? Math.max(7 * HOUR, nowY - el.clientHeight / 3) : 7 * HOUR;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const minuteAt = (ev: { clientY: number }, el: HTMLElement) => {
    const y = ev.clientY - el.getBoundingClientRect().top;
    return Math.max(0, Math.min(1440, Math.floor((y / HOUR) * 4) * 15));
  };

  const down = (i: number, ev: ReactPointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0 || ev.target !== ev.currentTarget) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const m = Math.floor(minuteAt(ev, ev.currentTarget) / 30) * 30;
    setSel({ day: i, a: m, b: m + 30 });
  };
  const move = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!sel) return;
    const m = minuteAt(ev, ev.currentTarget);
    setSel((s) => s && { ...s, b: Math.max(s.a + 15, Math.ceil(m / 15) * 15 + (m % 15 ? 0 : 15)) });
  };
  const up = () => {
    if (!sel) return;
    const d = days[sel.day];
    const at = (m: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, m);
    setSel(null);
    onCreate(at(sel.a), at(Math.min(sel.b, 1440)), false);
  };

  const cols = `56px repeat(${days.length}, minmax(0, 1fr))`;
  return (
    <div className="time-grid">
      <div className="tg-head" style={{ gridTemplateColumns: cols }}>
        <span className="tg-gutter muted small">{shortZone()}</span>
        {days.map((d, i) => (
          <button key={i} className={`tg-dayhead ${sameDay(d, now) ? 'today' : ''}`} onClick={() => onDay(d)}>
            <span className="tg-dow">{d.toLocaleDateString(undefined, { weekday: days.length > 1 ? 'short' : 'long' })}</span>
            <span className="tg-date">{d.getDate()}</span>
          </button>
        ))}
      </div>
      <div className="tg-allday" style={{ gridTemplateColumns: cols, gridTemplateRows: `repeat(${Math.max(1, lanes)}, 22px)` }}>
        <span className="tg-gutter muted small" style={{ gridRow: `1 / span ${Math.max(1, lanes)}` }}>
          all-day
        </span>
        {days.map((d, i) => (
          <div key={i} className="tg-allday-cell" style={{ gridColumn: i + 2, gridRow: `1 / span ${Math.max(1, lanes)}` }} onClick={() => onCreate(d, addDays(d, 1), true)} />
        ))}
        {spans.map((s) => (
          <button
            key={`${s.event.calendarId}:${s.event.uid}:${s.event.recurrenceId}`}
            className={`cal-bar ${stateClass(s.event)} ${s.continuesBefore ? 'cont-before' : ''} ${s.continuesAfter ? 'cont-after' : ''}`}
            style={{ ...colorVar(calendars, s.event), gridColumn: `${s.col + 2} / span ${s.span}`, gridRow: s.lane + 1 }}
            onClick={() => onOpen(s.event)}
            onContextMenu={(ev) => onMenu(s.event, ev)}
            title={s.event.summary}
          >
            <span className="ellipsis">{s.event.summary || '(no title)'}</span>
          </button>
        ))}
      </div>
      <div className="tg-scroll" ref={scroller}>
        <div className="tg-body" style={{ gridTemplateColumns: cols, height: 24 * HOUR }}>
          <div className="tg-hours">
            {Array.from({ length: 23 }, (_, h) => (
              <span key={h} style={{ top: (h + 1) * HOUR }}>
                {timeLabel(new Date(2000, 0, 1, h + 1)).replace(':00', '')}
              </span>
            ))}
          </div>
          {days.map((d, i) => {
            const items = layoutDay(timed, d);
            const isToday = sameDay(d, now);
            return (
              <div
                key={i}
                className={`tg-col ${isToday ? 'today' : ''} ${d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : ''}`}
                style={{ backgroundSize: `100% ${HOUR}px` }}
                onPointerDown={(ev) => down(i, ev)}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={() => setSel(null)}
              >
                {sel?.day === i && <div className="tg-selection" style={{ top: (sel.a / 60) * HOUR, height: ((sel.b - sel.a) / 60) * HOUR }} />}
                {items.map((it) => {
                  const height = Math.max(18, ((it.bottom - it.top) / 60) * HOUR - 2);
                  const b = eventBounds(it.event);
                  return (
                    <button
                      key={`${it.event.calendarId}:${it.event.uid}:${it.event.recurrenceId}`}
                      className={`cal-event ${stateClass(it.event)} ${height < 34 ? 'compact' : ''} ${b.end < now ? 'past' : ''}`}
                      style={{
                        ...colorVar(calendars, it.event),
                        top: (it.top / 60) * HOUR,
                        height,
                        left: `calc(${(it.column / it.columns) * 100}% + 1px)`,
                        width: `calc(${100 / it.columns}% - 3px)`,
                      }}
                      onClick={() => onOpen(it.event)}
                      onContextMenu={(ev) => onMenu(it.event, ev)}
                      title={`${it.event.summary}\n${timeLabel(b.start)} – ${timeLabel(b.end)}${it.event.location ? `\n${it.event.location}` : ''}`}
                    >
                      <span className="cal-event-title">
                        {it.event.recurring && <Icon name="repeat" size={11} />} {it.event.summary || '(no title)'}
                      </span>
                      {height >= 34 && (
                        <span className="cal-event-meta">
                          {timeLabel(b.start)} – {timeLabel(b.end)}
                          {it.event.location ? ` · ${it.event.location}` : ''}
                        </span>
                      )}
                    </button>
                  );
                })}
                {isToday && <div className="tg-now" style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR }} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function shortZone(): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/* ---------- month ---------- */

function MonthGrid({
  start,
  month,
  first,
  events,
  calendars,
  now,
  onCreate,
  onOpen,
  onMenu,
  onDay,
}: GridProps & { start: Date; month: number; first: number; onCreate: (d: Date) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [lanes, setLanes] = useState(3);

  // As many event lines as fit in a week row; the last is kept for "+N more".
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setLanes(Math.max(2, Math.floor((el.clientHeight / 6 - 26) / 21)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const names = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(start, first), i).toLocaleDateString(undefined, { weekday: 'short' }));
  return (
    <div className="month-grid">
      <div className="mg-names">
        {names.map((n) => (
          <span key={n}>{n}</span>
        ))}
      </div>
      <div className="mg-weeks" ref={box}>
        {Array.from({ length: 6 }, (_, w) => {
          const weekStart = addDays(start, w * 7);
          const items = layoutSpans(events, weekStart, 7);
          const visible = items.filter((i) => i.lane < lanes - 1);
          const hidden = Array.from({ length: 7 }, (_, c) => items.filter((i) => i.lane >= lanes - 1 && c >= i.col && c < i.col + i.span).length);
          return (
            <div key={w} className="mg-week" style={{ gridTemplateRows: `24px repeat(${lanes}, 21px) minmax(0, 1fr)` }}>
              {Array.from({ length: 7 }, (_, c) => {
                const d = addDays(weekStart, c);
                return (
                  <div
                    key={`cell${c}`}
                    className={`mg-cell ${d.getMonth() !== month ? 'other' : ''} ${sameDay(d, now) ? 'today' : ''}`}
                    style={{ gridColumn: c + 1 }}
                    onClick={(e) => e.target === e.currentTarget && onCreate(d)}
                  >
                    <button className="mg-date" onClick={() => onDay(d)} aria-label={d.toLocaleDateString(undefined, { dateStyle: 'full' })}>
                      {d.getDate() === 1 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.getDate()}
                    </button>
                  </div>
                );
              })}
              {visible.map((s) => {
                const spanning = isSpanning(s.event);
                const b = eventBounds(s.event);
                return (
                  <button
                    key={`${s.event.calendarId}:${s.event.uid}:${s.event.recurrenceId}`}
                    className={`${spanning ? 'cal-bar' : 'cal-dot-event'} ${stateClass(s.event)} ${s.continuesBefore ? 'cont-before' : ''} ${s.continuesAfter ? 'cont-after' : ''}`}
                    style={{ ...colorVar(calendars, s.event), gridColumn: `${s.col + 1} / span ${s.span}`, gridRow: s.lane + 2 }}
                    onClick={() => onOpen(s.event)}
                    onContextMenu={(ev) => onMenu(s.event, ev)}
                    title={spanning ? s.event.summary : `${timeLabel(b.start)} ${s.event.summary}`}
                  >
                    {!spanning && <span className="dot" />}
                    {!spanning && <span className="cal-dot-time">{timeLabel(b.start)}</span>}
                    <span className="ellipsis">{s.event.summary || '(no title)'}</span>
                  </button>
                );
              })}
              {hidden.map((n, c) =>
                n > 0 ? (
                  <button key={`more${c}`} className="mg-more" style={{ gridColumn: c + 1, gridRow: lanes + 1 }} onClick={() => onDay(addDays(weekStart, c))}>
                    +{n} more
                  </button>
                ) : null,
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

