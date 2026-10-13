import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { HttpError, badRequest, parse } from '../http.js';
import { oauthAvailable } from '../oauth.js';
import { discover } from '../calendar/caldav.js';
import { feedName, feedUrl, fetchFeed } from '../calendar/feed.js';
import { CALENDAR_PROVIDERS, calendarProvider } from '../calendar/providers.js';
import { isIanaZone, zonedToUtc } from '../calendar/tz.js';
import {
  createEvent,
  deleteEvent,
  getSeries,
  listOccurrences,
  publicCalendar,
  publicSource,
  syncSource,
  syncStale,
  updateEvent,
} from '../calendar/service.js';
import {
  PALETTE,
  calendarsOf,
  createLocalCalendar,
  createSource,
  deleteCalendar,
  deleteSource,
  ensureLocalSource,
  getCalendar,
  getSource,
  listCalendars,
  listSources,
  normalizeColor,
  readSourceSecret,
  setSourceStatus,
  updateCalendar,
  updateSource,
  writeSourceSecret,
} from '../calendar/store.js';

export const calendarRouter = Router();

const tzParam = z
  .string()
  .max(64)
  .default('UTC')
  .transform((tz) => (isIanaZone(tz) ? tz : 'UTC'));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const color = z.string().transform((c, ctx) => normalizeColor(c) ?? (ctx.addIssue({ code: 'custom', message: 'not a colour' }), z.NEVER));

function state(userId: number) {
  ensureLocalSource(userId);
  return {
    sources: listSources(userId).map(publicSource),
    calendars: listCalendars(userId).map(publicCalendar),
  };
}

calendarRouter.get('/calendar', requireUser, (req, res) => {
  const body = state(req.user!.id);
  // Opening the calendar refreshes anything more than five minutes old.
  syncStale(req.user!.id, 5 * 60_000);
  res.json(body);
});

calendarRouter.get('/calendar/providers', requireUser, (_req, res) => {
  const oauth = oauthAvailable();
  res.json(
    CALENDAR_PROVIDERS.map((p) => ({
      ...p,
      available: p.kind === 'google' ? oauth.google : p.kind === 'microsoft' ? oauth.microsoft : true,
    })),
  );
});

calendarRouter.get('/calendar/events', requireUser, (req, res) => {
  const q = parse(z.object({ from: date, to: date, tz: tzParam }), req.query);
  const at = (d: string) => zonedToUtc({ year: +d.slice(0, 4), month: +d.slice(5, 7), day: +d.slice(8, 10), hour: 0, minute: 0, second: 0 }, q.tz);
  const from = at(q.from);
  const to = at(q.to);
  if (to <= from || to - from > 400 * 86400_000) throw badRequest('Ask for at most 400 days at a time');
  res.json(listOccurrences(req.user!.id, { from, to, fromDate: q.from, toDate: q.to, tz: q.tz }));
});

/* ---------- events ---------- */

const eventBody = z.object({
  summary: z.string().trim().max(500).default(''),
  location: z.string().trim().max(1000).default(''),
  description: z.string().max(50_000).default(''),
  allDay: z.boolean(),
  start: z.string().max(16),
  end: z.string().max(16),
  timeZone: z.string().max(64),
  rrule: z.string().trim().max(500).nullable().default(null),
});
const target = z.object({
  uid: z.string().min(1).max(1000),
  recurrenceId: z.string().max(40).nullable().default(null),
  scope: z.enum(['series', 'occurrence']).default('series'),
});

const calId = (p: unknown) => parse(z.coerce.number().int().positive(), p);

calendarRouter.post('/calendar/calendars/:id/events', requireUser, async (req, res) => {
  const body = parse(eventBody, req.body);
  await createEvent(req.user!.id, calId(req.params.id), { ...body, summary: body.summary || '(no title)' });
  res.json({ ok: true });
});

calendarRouter.put('/calendar/calendars/:id/events', requireUser, async (req, res) => {
  const body = parse(target.extend({ event: eventBody }), req.body);
  await updateEvent(req.user!.id, calId(req.params.id), body.uid, { ...body.event, summary: body.event.summary || '(no title)' }, body.scope, body.recurrenceId);
  res.json({ ok: true });
});

calendarRouter.delete('/calendar/calendars/:id/events', requireUser, async (req, res) => {
  const body = parse(target, req.body);
  await deleteEvent(req.user!.id, calId(req.params.id), body.uid, body.scope, body.recurrenceId);
  res.json({ ok: true });
});

calendarRouter.get('/calendar/calendars/:id/series', requireUser, async (req, res) => {
  const q = parse(z.object({ uid: z.string().min(1).max(1000), tz: tzParam }), req.query);
  res.json(await getSeries(req.user!.id, calId(req.params.id), q.uid, q.tz));
});

/* ---------- calendars ---------- */

calendarRouter.post('/calendar/calendars', requireUser, (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(100), color: color.optional() }), req.body);
  const local = ensureLocalSource(req.user!.id);
  const n = calendarsOf(local.id).length;
  createLocalCalendar(local.id, body.name, body.color ?? PALETTE[n % PALETTE.length]);
  res.json(state(req.user!.id));
});

calendarRouter.patch('/calendar/calendars/:id', requireUser, (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(100).optional(), color: color.optional(), visible: z.boolean().optional() }), req.body);
  const { cal, source } = getCalendar(req.user!.id, calId(req.params.id));
  if (body.name !== undefined && source.kind !== 'local') throw badRequest('Rename this calendar where it is hosted');
  updateCalendar(cal.id, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.color !== undefined ? { color: body.color } : {}),
    ...(body.visible !== undefined ? { visible: body.visible ? 1 : 0 } : {}),
  });
  res.json(state(req.user!.id));
});

calendarRouter.delete('/calendar/calendars/:id', requireUser, (req, res) => {
  const { cal, source } = getCalendar(req.user!.id, calId(req.params.id));
  if (source.kind !== 'local') throw badRequest('Remove the calendar account instead, or hide this calendar');
  if (calendarsOf(source.id).length <= 1) throw badRequest('You need at least one calendar on this server');
  deleteCalendar(cal.id);
  res.json(state(req.user!.id));
});

/* ---------- calendar accounts ---------- */

const sourceBody = z.object({
  provider: z.string().max(40),
  label: z.string().trim().max(100).optional(),
  url: z.string().trim().max(2000).optional(),
  username: z.string().trim().max(320).optional(),
  password: z.string().max(2000).optional(),
  allowInsecureTls: z.boolean().default(false),
});

calendarRouter.post('/calendar/sources', requireUser, async (req, res) => {
  const body = parse(sourceBody, req.body);
  const preset = calendarProvider(body.provider);
  if (!preset) throw badRequest('Unknown calendar provider');
  const userId = req.user!.id;
  let source;
  if (preset.kind === 'caldav') {
    const url = body.url || preset.url;
    if (!url) throw badRequest('Server address is required');
    if (!body.username || !body.password) throw badRequest('Username and password are required');
    const found = await discover(url, { user: body.username, pass: body.password, insecureTls: body.allowInsecureTls });
    if (!found.calendars.length) throw new HttpError(502, 'Signed in, but no calendars were found on that account');
    source = createSource(
      userId,
      { kind: 'caldav', provider: preset.id, label: body.label || `${preset.id === 'caldav' ? new URL(found.home).hostname : preset.name} (${body.username})`, url: found.home, username: body.username, allow_insecure_tls: body.allowInsecureTls ? 1 : 0 },
      { password: body.password },
    );
  } else if (preset.kind === 'ics') {
    if (!body.url) throw badRequest('Calendar address is required');
    const draft = { url: body.url, username: body.username || null, allow_insecure_tls: body.allowInsecureTls ? 1 : 0 };
    const ics = await fetchFeed(draft, body.password);
    source = createSource(
      userId,
      { kind: 'ics', provider: 'ics', label: body.label || feedName(ics) || new URL(feedUrl(body.url)).hostname, ...draft },
      { password: body.password || undefined },
    );
  } else {
    throw badRequest(`${preset.name} uses sign-in instead of a password`);
  }
  await syncSource(source.id).catch(() => {});
  res.json(state(userId));
});

calendarRouter.put('/calendar/sources/:id', requireUser, async (req, res) => {
  const body = parse(sourceBody.partial().omit({ provider: true }), req.body);
  const source = getSource(req.user!.id, calId(req.params.id));
  if (source.kind === 'local') throw badRequest('Nothing to change here');
  const fields: Parameters<typeof updateSource>[1] = {};
  if (body.label) fields.label = body.label;
  if (source.kind === 'caldav' || source.kind === 'ics') {
    const url = body.url ?? source.url ?? '';
    const username = body.username ?? source.username ?? '';
    const password = body.password || readSourceSecret(source).password || '';
    const insecure = body.allowInsecureTls ?? !!source.allow_insecure_tls;
    if (source.kind === 'caldav') {
      // Check the new details before saving them.
      if (body.url !== undefined || body.username !== undefined || body.password || body.allowInsecureTls !== undefined) {
        const found = await discover(url, { user: username, pass: password, insecureTls: insecure });
        fields.url = found.home;
      }
    } else if (body.url !== undefined) {
      await fetchFeed({ url, username: username || null, allow_insecure_tls: insecure ? 1 : 0 }, password);
      fields.url = url;
    }
    if (body.username !== undefined) fields.username = username || null;
    if (body.allowInsecureTls !== undefined) fields.allow_insecure_tls = insecure ? 1 : 0;
    if (body.password) writeSourceSecret(source.id, { ...readSourceSecret(source), password });
  }
  updateSource(source.id, fields);
  setSourceStatus(source.id, null, false);
  for (const c of calendarsOf(source.id)) updateCalendar(c.id, { sync_state: null });
  await syncSource(source.id).catch(() => {});
  res.json(state(req.user!.id));
});

calendarRouter.delete('/calendar/sources/:id', requireUser, (req, res) => {
  const source = getSource(req.user!.id, calId(req.params.id));
  if (source.kind === 'local') throw badRequest('The calendars on this server cannot be removed this way');
  deleteSource(req.user!.id, source.id);
  res.json(state(req.user!.id));
});

calendarRouter.post('/calendar/sources/:id/sync', requireUser, async (req, res) => {
  const source = getSource(req.user!.id, calId(req.params.id));
  await syncSource(source.id).catch(() => {});
  res.json(state(req.user!.id));
});

calendarRouter.post('/calendar/sync', requireUser, async (req, res) => {
  await Promise.all(listSources(req.user!.id).map((s) => syncSource(s.id).catch(() => {})));
  res.json(state(req.user!.id));
});
