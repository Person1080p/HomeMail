import type { SourceKind } from './store.js';

export interface CalendarProvider {
  id: string;
  name: string;
  kind: Exclude<SourceKind, 'local'>;
  /** Server address filled in for the user. */
  url?: string;
  /** Placeholder when the user has to supply the address. */
  urlHint?: string;
  usernameHint?: string;
  notes: string;
  helpUrl?: string;
}

export const CALENDAR_PROVIDERS: CalendarProvider[] = [
  {
    id: 'google',
    name: 'Google Calendar',
    kind: 'google',
    notes: 'Sign in with your Google account. All the calendars you see in Google Calendar are added, including shared ones.',
  },
  {
    id: 'microsoft',
    name: 'Outlook.com / Microsoft 365',
    kind: 'microsoft',
    notes: 'Sign in with your Microsoft account. Events from six months ago to eighteen months ahead are kept in sync.',
  },
  {
    id: 'icloud',
    name: 'iCloud (Apple Calendar)',
    kind: 'caldav',
    url: 'https://caldav.icloud.com/',
    usernameHint: 'Apple ID email',
    notes: 'Apple requires an app-specific password: account.apple.com → Sign-In and Security → App-Specific Passwords. Your normal Apple ID password will not work.',
    helpUrl: 'https://support.apple.com/en-us/102654',
  },
  {
    id: 'fastmail',
    name: 'Fastmail',
    kind: 'caldav',
    url: 'https://caldav.fastmail.com/dav/',
    usernameHint: 'you@fastmail.com',
    notes: 'Create an app password with calendar (CalDAV) access in Settings → Privacy & Security → Manage app passwords.',
    helpUrl: 'https://www.fastmail.help/hc/en-us/articles/360058752854',
  },
  {
    id: 'yahoo',
    name: 'Yahoo Calendar',
    kind: 'caldav',
    url: 'https://caldav.calendar.yahoo.com/',
    usernameHint: 'you@yahoo.com',
    notes: 'Generate an app password in Yahoo Account Security → App passwords.',
  },
  {
    id: 'nextcloud',
    name: 'Nextcloud / ownCloud',
    kind: 'caldav',
    urlHint: 'https://cloud.example.com/remote.php/dav',
    notes: 'Use an app password from Personal settings → Security → Devices & sessions.',
  },
  {
    id: 'caldav',
    name: 'Other CalDAV server',
    kind: 'caldav',
    urlHint: 'https://dav.example.com/',
    notes: 'Radicale, Baïkal, Synology Calendar, mailbox.org, Posteo, Zoho, Stalwart and others. Enter the server or calendar address; HomeMail finds the calendars.',
  },
  {
    id: 'ics',
    name: 'Subscribe by URL (.ics / webcal)',
    kind: 'ics',
    urlHint: 'webcal://example.com/calendar.ics',
    notes: 'Read-only. Public holidays, sports fixtures, school terms, or a calendar someone shared as a link (Google "secret address in iCal format", Outlook "Publish calendar").',
  },
];

export const calendarProvider = (id: string) => CALENDAR_PROVIDERS.find((p) => p.id === id);
