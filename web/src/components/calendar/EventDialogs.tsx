import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, qs } from '../../api';
import type { CalEvent, CalendarInfo, SeriesInfo } from '../../types';
import { Icon } from '../Icon';
import { Menu, Modal, linkify } from '../ui';
import {
  type RepeatEnd,
  type RepeatKind,
  addDays,
  buildRrule,
  describeRrule,
  eventBounds,
  hm,
  parseRrule,
  parseYmd,
  repeatLabel,
  timeZone,
  whenText,
  ymd,
} from './dates';

export type Scope = 'series' | 'occurrence';

/** The form's values; all-day end dates are inclusive here, as people think of them. */
export interface Draft {
  summary: string;
  location: string;
  description: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  rrule: string | null;
}

export function draftFor(start: Date, end: Date, allDay: boolean): Draft {
  return {
    summary: '',
    location: '',
    description: '',
    allDay,
    startDate: ymd(start),
    startTime: hm(start),
    endDate: ymd(allDay ? addDays(end, -1) : end),
    endTime: hm(end),
    rrule: null,
  };
}

function draftFromTimes(src: { summary: string; location: string; description: string; allDay: boolean; start: string; end: string }, rrule: string | null): Draft {
  const { start, end } = eventBounds({ ...src, calendarId: 0, uid: '', recurrenceId: null, recurring: false, status: 'confirmed' });
  return { ...draftFor(start, end, src.allDay), summary: src.summary, location: src.location, description: src.description, rrule };
}

export const draftFromEvent = (e: CalEvent) => draftFromTimes(e, null);
export const draftFromSeries = (s: SeriesInfo) => draftFromTimes(s, s.rrule);

export interface EditorRequest {
  draft: Draft;
  calendarId: number;
  /** Present when editing an existing event. */
  event?: CalEvent;
  scope: Scope;
}

export function EventEditor({ request, calendars, onClose, onSaved }: { request: EditorRequest; calendars: CalendarInfo[]; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(request.draft);
  const [calendarId, setCalendarId] = useState(request.calendarId);
  const startDay = parseYmd(d.startDate || ymd(new Date()));
  const parsed = useMemo(() => parseRrule(request.draft.rrule, parseYmd(request.draft.startDate)), [request.draft]);
  const [repeat, setRepeat] = useState<RepeatKind>(parsed.kind);
  const [repeatEnd, setRepeatEnd] = useState<RepeatEnd>(parsed.end);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const title = useRef<HTMLInputElement>(null);
  const editing = !!request.event;
  const occurrenceOnly = editing && request.scope === 'occurrence' && request.event!.recurring;
  const writable = calendars.filter((c) => !c.readOnly || c.id === request.calendarId);

  useEffect(() => title.current?.focus(), []);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  /** Moving the start keeps the duration, like Outlook. */
  const moveStart = (date: string, time: string) => {
    if (!date) return set('startDate', date);
    const oldStart = parseYmd(d.startDate).getTime() + minutes(d.startTime) * 60_000;
    const oldEnd = parseYmd(d.endDate).getTime() + minutes(d.endTime) * 60_000;
    const next = parseYmd(date).getTime() + minutes(time) * 60_000;
    const end = new Date(next + Math.max(0, oldEnd - oldStart));
    setD((x) => ({ ...x, startDate: date, startTime: time, endDate: ymd(end), endTime: x.allDay ? x.endTime : hm(end) }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const start = d.allDay ? d.startDate : `${d.startDate}T${d.startTime}`;
    const end = d.allDay ? ymd(addDays(parseYmd(d.endDate), 1)) : `${d.endDate}T${d.endTime}`;
    if (!d.startDate || !d.endDate || (!d.allDay && (!d.startTime || !d.endTime))) return setError('Fill in the start and end');
    if (d.allDay ? d.endDate < d.startDate : end < start) return setError('The event ends before it starts');
    const event = {
      summary: d.summary.trim(),
      location: d.location.trim(),
      description: d.description,
      allDay: d.allDay,
      start,
      end,
      timeZone: timeZone(),
      rrule: occurrenceOnly ? null : buildRrule(repeat, startDay, repeatEnd, d.allDay, request.draft.rrule),
    };
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api('PUT', `/calendar/calendars/${calendarId}/events`, { uid: request.event!.uid, recurrenceId: request.event!.recurrenceId, scope: request.scope, event });
      } else {
        await api('POST', `/calendar/calendars/${calendarId}/events`, event);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const heading = !editing ? 'New event' : occurrenceOnly ? 'Edit this occurrence' : request.event!.recurring ? 'Edit series' : 'Edit event';
  return (
    <Modal
      title={heading}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="event-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="event-form" className="stack event-form" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <input ref={title} className="event-title-input" placeholder="Add a title" value={d.summary} onChange={(e) => set('summary', e.target.value)} aria-label="Title" maxLength={500} />
        <label>
          Calendar
          <select value={calendarId} onChange={(e) => setCalendarId(Number(e.target.value))} disabled={editing}>
            {writable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="event-times">
          <label>
            Start
            <span className="event-time-row">
              <input type="date" value={d.startDate} onChange={(e) => moveStart(e.target.value, d.startTime)} required />
              {!d.allDay && <input type="time" value={d.startTime} step={300} onChange={(e) => moveStart(d.startDate, e.target.value)} required />}
            </span>
          </label>
          <label>
            End
            <span className="event-time-row">
              <input type="date" value={d.endDate} min={d.startDate} onChange={(e) => set('endDate', e.target.value)} required />
              {!d.allDay && <input type="time" value={d.endTime} step={300} onChange={(e) => set('endTime', e.target.value)} required />}
            </span>
          </label>
        </div>
        <label className="inline">
          <input
            type="checkbox"
            checked={d.allDay}
            onChange={(e) => {
              const allDay = e.target.checked;
              // Switching to timed on a single day gives a sensible hour rather than midnight to midnight.
              setD((x) => (allDay ? { ...x, allDay } : { ...x, allDay, startTime: x.startTime === '00:00' ? '09:00' : x.startTime, endTime: x.endTime === '00:00' ? '10:00' : x.endTime }));
            }}
          />
          All day
        </label>
        {!occurrenceOnly && (
          <div className="event-repeat">
            <label>
              Repeat
              <select value={repeat} onChange={(e) => setRepeat(e.target.value as RepeatKind)}>
                {(['none', 'daily', 'weekdays', 'weekly', 'monthlyDay', 'monthlyNth', 'yearly'] as RepeatKind[]).map((k) => (
                  <option key={k} value={k}>
                    {repeatLabel(k, startDay)}
                  </option>
                ))}
                {parsed.kind === 'custom' && <option value="custom">{describeRrule(request.draft.rrule, startDay)} (kept as it is)</option>}
              </select>
            </label>
            {repeat !== 'none' && repeat !== 'custom' && (
              <label>
                Ends
                <span className="event-time-row">
                  <select value={repeatEnd.type} onChange={(e) => setRepeatEnd({ ...repeatEnd, type: e.target.value as RepeatEnd['type'] })}>
                    <option value="never">Never</option>
                    <option value="until">On date</option>
                    <option value="count">After</option>
                  </select>
                  {repeatEnd.type === 'until' && <input type="date" value={repeatEnd.until} min={d.startDate} onChange={(e) => setRepeatEnd({ ...repeatEnd, until: e.target.value })} />}
                  {repeatEnd.type === 'count' && (
                    <span className="event-count">
                      <input type="number" min={1} max={999} value={repeatEnd.count} onChange={(e) => setRepeatEnd({ ...repeatEnd, count: Number(e.target.value) })} /> times
                    </span>
                  )}
                </span>
              </label>
            )}
            {editing && request.event!.recurring && <p className="note">Changing the time or pattern of a series resets occurrences that were changed individually.</p>}
          </div>
        )}
        <label>
          Location
          <input value={d.location} onChange={(e) => set('location', e.target.value)} maxLength={1000} />
        </label>
        <label>
          Notes
          <textarea rows={4} value={d.description} onChange={(e) => set('description', e.target.value)} />
        </label>
      </form>
    </Modal>
  );
}

const minutes = (t: string) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : 0);

export function EventDetails({
  event,
  calendar,
  onClose,
  onEdit,
  onDelete,
}: {
  event: CalEvent;
  calendar: CalendarInfo | undefined;
  onClose: () => void;
  onEdit: (scope: Scope) => void;
  onDelete: (scope: Scope) => void;
}) {
  const [series, setSeries] = useState<SeriesInfo | null>(null);
  const readOnly = !calendar || calendar.readOnly;
  useEffect(() => {
    if (!event.recurring) return;
    api<SeriesInfo>('GET', `/calendar/calendars/${event.calendarId}/series?${qs({ uid: event.uid, tz: timeZone() })}`)
      .then(setSeries)
      .catch(() => {});
  }, [event]);
  const seriesStart = series ? eventBounds({ ...event, ...series }).start : null;

  return (
    <Modal
      title={event.summary || '(no title)'}
      onClose={onClose}
      footer={
        readOnly ? (
          <button className="btn" onClick={onClose}>
            Close
          </button>
        ) : event.recurring ? (
          <>
            <Menu
              trigger={(open) => (
                <button className="btn btn-danger" onClick={open} aria-haspopup="menu">
                  <Icon name="trash" /> Delete <Icon name="chevronDown" size={14} />
                </button>
              )}
            >
              {(close) => (
                <>
                  <button role="menuitem" className="danger" onClick={() => (close(), onDelete('occurrence'))}>
                    This occurrence
                  </button>
                  <button role="menuitem" className="danger" onClick={() => (close(), onDelete('series'))}>
                    The whole series
                  </button>
                </>
              )}
            </Menu>
            <span className="spacer" />
            <button className="btn" onClick={() => onEdit('series')}>
              Edit series
            </button>
            <button className="btn btn-primary" onClick={() => onEdit('occurrence')}>
              <Icon name="pencil" /> Edit occurrence
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-danger" onClick={() => onDelete('series')}>
              <Icon name="trash" /> Delete
            </button>
            <span className="spacer" />
            <button className="btn btn-primary" onClick={() => onEdit('series')}>
              <Icon name="pencil" /> Edit
            </button>
          </>
        )
      }
    >
      <div className="event-details">
        {event.status !== 'confirmed' && <div className={`tag event-status-${event.status}`}>{event.status === 'cancelled' ? 'Cancelled' : 'Tentative'}</div>}
        <div className="event-detail-row">
          <Icon name="clock" />
          <span>{whenText(event)}</span>
        </div>
        {event.recurring && (
          <div className="event-detail-row">
            <Icon name="repeat" />
            <span>{series && seriesStart ? describeRrule(series.rrule, seriesStart) || 'Part of a series' : 'Part of a series'}</span>
          </div>
        )}
        {event.location && (
          <div className="event-detail-row">
            <Icon name="mapPin" />
            <span dangerouslySetInnerHTML={{ __html: linkify(event.location) }} />
          </div>
        )}
        <div className="event-detail-row">
          <span className="cal-swatch" style={{ background: calendar?.color }} />
          <span>
            {calendar?.name ?? 'Calendar'}
            {readOnly && <span className="muted"> · read-only</span>}
          </span>
        </div>
        {event.description && <div className="event-description" dangerouslySetInnerHTML={{ __html: linkify(event.description) }} />}
      </div>
    </Modal>
  );
}
