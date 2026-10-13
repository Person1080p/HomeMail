# HomeMail

A self-hosted, multi-user webmail client in the spirit of Thunderbird, built for homelabs.

- **Multiple users**: each with their own login and their own set of mail accounts. The first user becomes the admin; admins add users (or open registration).
- **Many accounts per user** in one three-pane view (folders | messages | reader), with an **All Inboxes** view that merges every account, unread counts, search, stars, drag-and-drop to folders, drafts, attachments, signatures, keyboard shortcuts, dark mode and a phone layout.
- **Tabs above the reading pane**: clicking a message shows it in the *Preview* tab; double-click (or Enter) opens it in its own tab, and every new message, reply and forward opens in a compose tab there, with the folder list and message list still beside it. The expand button gives a tab the full width. Open tabs come back after a reload.
- **Outlook-style editor**: fonts and sizes, colours and highlight, headings, lists and indent, alignment, sub/superscript, links, pasted or inserted pictures (sent as proper inline attachments), tables, importance and read receipts. Replies keep the original message intact below what you write.
- **Your own addresses on the server**: every user gets `username@your-domain` for email and for chat.
  - **Mail**: a bundled [Stalwart](https://stalw.art) mail server (Docker default, real IMAP that also works in Thunderbird and on phones), a minimal built-in server (default when run from source), another server you already run, or off. Admins switch in *Settings → Server*.
  - **Chat**: real-time direct messages and group chats with unread badges, typing and online indicators, and desktop notifications. With the bundled [Prosody](https://prosody.im) (Docker default), people on other XMPP servers and apps (Conversations, Gajim, …) can chat with your users too.
- **Calendar**: a Calendar tab with day, work week, week and month views, a mini month and per-calendar colours, plus Outlook-style editing of repeating events (one occurrence or the whole series). Syncs both ways with **Google Calendar**, **Outlook.com / Microsoft 365**, **iCloud**, Fastmail, Yahoo, Nextcloud and any CalDAV server (Radicale, Baïkal, Synology, …). Also subscribes to read-only `.ics`/`webcal` feeds such as public holidays, and keeps calendars on this server.
- **Providers**: Gmail, Outlook.com/Hotmail, Microsoft 365, Yahoo, AOL, iCloud (Apple), Proton Mail (through Proton Mail Bridge), Fastmail, Zoho, GMX, and any IMAP or POP3 server. Settings are detected from the email address the way Thunderbird does it (built-in presets, MX lookup, Mozilla ISPDB).
- **Export** a user's accounts to Thunderbird, Thunderbird for Android (QR codes), K-9 Mail, Apple Mail (macOS/iOS), Mozilla autoconfig XML (Evolution, KMail, FairEmail…), a printable settings sheet, or a HomeMail backup.
- **Import** accounts from your existing Thunderbird (`prefs.js`) or a HomeMail backup.

> **Tuta (Tutanota) cannot be supported.** Tuta offers no IMAP, POP3 or SMTP access and no bridge, so no third-party client (Thunderbird included) can connect to it. HomeMail shows this when you pick Tuta. Your options are Tuta's own apps, or forwarding Tuta mail to another mailbox.

---

## Quick start (Docker Compose)

```bash
cp .env.example .env
# In .env set: APP_SECRET (openssl rand -base64 48), STALWART_ADMIN_PASSWORD and
# XMPP_COMPONENT_SECRET (openssl rand -base64 24 each), and PUBLIC_URL.
docker compose up -d --build
```

Open `PUBLIC_URL` (default http://localhost:3000) and create the first user. That user is the administrator.

This starts three containers: `homemail` (the web app), `homemail-stalwart` (mail server) and `homemail-prosody` (chat federation). Stalwart publishes ports 25, 465 and 993, and Prosody port 5269; remove those port mappings in `docker-compose.yml` if you don't want them on the host.

Data lives in the `homemail-data`, `stalwart-data` and `prosody-data` volumes. **Back up those volumes and your `.env`**: stored mail passwords and OAuth tokens are encrypted with `APP_SECRET`.

### HTTPS / reverse proxy

Put HomeMail behind your usual reverse proxy (Caddy, Traefik, nginx, NPM…) and set `PUBLIC_URL=https://mail.your.domain`. With an `https` URL, session cookies are marked `Secure`. By default, proxies on loopback and private networks are trusted for `X-Forwarded-*` headers (`TRUST_PROXY`).

HomeMail does **not** need to be reachable from the internet, even for Google/Microsoft sign-in. Those redirects happen in your browser. It does need HTTPS and a real domain name (one that resolves on your LAN is fine; Let's Encrypt DNS challenge works well).

---

## Your server's own email and chat addresses

Every user gets `username@CHAT_DOMAIN` for chat and `username@MAIL_DOMAIN` for email (they can be the same domain). The defaults, `home.mail` for chat and `home.internal` for Stalwart mail, only work between users on this server. *My addresses & password* in Settings shows each user their addresses.

To exchange mail and chat with the rest of the internet, use a domain you own. Set it in `.env` (`SERVER_DOMAIN=example.com`) or in *Settings → Server*, then publish the DNS records that page lists.

### Mail server modes (*Settings → Server*)

| Mode | What users get | Notes |
|---|---|---|
| **Stalwart** (Docker default) | A real IMAP mailbox per user, created automatically, that also works in Thunderbird and on phones. *My addresses* gives each user an app password and the server settings. | Spam filtering, DKIM and TLS certificates are handled by Stalwart; its admin page is at http://127.0.0.1:8080/admin (user `admin`, password `STALWART_ADMIN_PASSWORD`). The Server page shows the DNS records Stalwart wants. Stalwart only accepts domains under a real top-level domain, hence `home.internal` rather than `home.mail`. |
| **Built-in** (default from source) | A mailbox inside HomeMail. Mail between users is delivered instantly. | Receives mail over SMTP on `BUILTIN_SMTP_PORT` (forward port 25 to it) for your users only, so it is never an open relay. Sends to other domains directly or through a relay (smarthost), DKIM-signed, with a retrying queue and bounces. No IMAP for other apps and no spam filter. |
| **External** | Nothing is created. When users add an address on your domain, the admin's server settings are filled in. | For an existing Mailcow, docker-mailserver, etc. |
| **Off** | Only outside accounts. | |

Sending mail from home: many ISPs block outgoing port 25 and residential IPs are often on block lists, so most homelabs need a relay (your ISP's, SMTP2GO, Mailgun, Amazon SES…). Set it in *Settings → Server* for the built-in server, or in Stalwart's admin page.

### Chat federation (XMPP)

HomeMail connects to Prosody as an XMPP component and answers for every `user@CHAT_DOMAIN`, so chats stay in HomeMail while Prosody handles the connections to other servers. For the public XMPP network you need:

- DNS: `_xmpp-server._tcp.CHAT_DOMAIN. SRV 0 5 5269 your.host.` (or an A record on the domain itself),
- port 5269 reachable from the internet,
- a certificate for the chat domain in `deploy/prosody/certs/` (see the README there).

Admins can turn federation off in *Settings → Server*. Direct messages federate; group chats are for users on this server.

---

## Adding accounts: provider notes

| Provider | How to sign in |
|---|---|
| **Gmail / Google Workspace** | Easiest: turn on 2-Step Verification and create an [app password](https://myaccount.google.com/apppasswords). Or use "Sign in with Google" once an admin configures it (below). |
| **Outlook.com / Hotmail / Live** | Microsoft no longer accepts passwords or app passwords for IMAP/SMTP on personal accounts. **Requires "Sign in with Microsoft"** (admin setup below). |
| **Microsoft 365 (work/school)** | "Sign in with Microsoft". Your organisation must allow IMAP and SMTP AUTH for the mailbox. |
| **Yahoo / AOL** | App password: Account Security → Generate app password. |
| **iCloud (Apple)** | App-specific password from [account.apple.com](https://account.apple.com) → Sign-In and Security. iCloud has no POP3. |
| **Proton Mail** | Needs [Proton Mail Bridge](https://proton.me/mail/bridge) (paid plan) running in your homelab. See the commented service in `docker-compose.yml`. Use the username and password shown by `info` in the Bridge CLI. The preset already enables "allow self-signed certificates". |
| **Tuta** | Not possible (see above). |
| **Fastmail / Zoho / GMX** | App password (Fastmail), or enable IMAP in the provider's settings first (Zoho, GMX). |
| **Anything else** | Enter the email address. HomeMail tries known presets, the domain's MX records and Mozilla's ISPDB, then falls back to `imap.`/`smtp.` guesses that you can edit. |

### Calendars

Add calendars in *Settings → Calendars* (or *Add calendar account* in the Calendar tab).

| Service | How to connect |
|---|---|
| **Google Calendar** | "Sign in with Google" (admin setup below, with the Calendar API enabled). Without it, subscribe read-only to a calendar's *secret address in iCal format* from Google Calendar's settings. |
| **Outlook.com / Microsoft 365** | "Sign in with Microsoft" (admin setup below). Events from 6 months back to 18 months ahead are synced. |
| **iCloud (Apple Calendar)** | Apple ID email and an [app-specific password](https://support.apple.com/en-us/102654). |
| **Fastmail / Yahoo** | App password. |
| **Nextcloud, Radicale, Baïkal, Synology, mailbox.org, Posteo, Zoho, Stalwart, …** | "Other CalDAV server": the server or calendar URL plus username and password. HomeMail finds the calendars (RFC 6764 discovery). |
| **Holiday, sports or school calendars, published calendars** | "Subscribe by URL" with the `.ics` or `webcal://` link. Read-only. |

Changes you make are written to the service straight away. Changes made elsewhere arrive every `CALENDAR_SYNC_MINUTES` (default 15), when you open the Calendar tab, or with its sync button.

IMAP accounts work directly against the server, so nothing is copied into HomeMail. POP3 accounts download mail into HomeMail's data volume. "Leave messages on the server" is on by default, and new mail is checked every `POP3_POLL_MINUTES`.

---

## Admin setup: Sign in with Google / Microsoft (optional)

Both flows use the redirect URI `PUBLIC_URL/api/oauth/<provider>/callback`. The admin page in HomeMail shows the exact URIs. Mail and calendar sign-ins share that URI; each asks only for its own permissions.

### Google

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project.
2. Open **Google Auth Platform**. Set up branding with user type **External**. Under *Data access*, add the scope `https://mail.google.com/`, and `https://www.googleapis.com/auth/calendar` for calendars. For calendars, also enable the **Google Calendar API** under *APIs & Services → Library*.
3. Under **Clients**, create an OAuth client of type **Web application**. Add the redirect URI `https://mail.your.domain/api/oauth/google/callback`.
4. Under **Audience**, set the publishing status to **In production**. Apps left in *Testing* get refresh tokens that expire after 7 days. For personal use the app can stay unverified; people see a "Google hasn't verified this app" warning and click *Advanced → continue*. Unverified apps are limited to 100 users.
5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env` and restart.

### Microsoft (Outlook.com, Hotmail, Microsoft 365)

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), go to *App registrations* → **New registration**. A free Azure account works for personal use.
2. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
3. Redirect URI: platform **Web**, `https://mail.your.domain/api/oauth/microsoft/callback`.
4. Under *Certificates & secrets*, create a client secret and copy its **value**.
5. Under *API permissions*, add these Microsoft Graph delegated permissions: `IMAP.AccessAsUser.All`, `POP.AccessAsUser.All`, `SMTP.Send`, `offline_access`, `openid`, `email`, `profile`, and `Calendars.ReadWrite` for calendars.
6. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` and `MICROSOFT_TENANT=common` (or `consumers` for personal accounts only), then restart.

---

## Exporting accounts to other clients

*Settings → Export / import.* Pick the accounts to include. Mail passwords are left out unless you tick "Include mail passwords" and confirm with your HomeMail password.

| Target | What you get | How to use it |
|---|---|---|
| **Thunderbird** (desktop) | `.zip` containing `prefs.js` | Thunderbird → Tools → Import → *Import from another Thunderbird installation* → *Select a profile folder or zip file*. The accounts are added next to your existing ones. Thunderbird asks for passwords on first use (it can't import them), and opens Google/Microsoft sign-in for OAuth accounts. |
| **Thunderbird for Android** | QR codes (the same format as desktop Thunderbird's "Export for Mobile", 3 accounts per code) | In the app: *Import from Thunderbird desktop*, then scan each code. |
| **K-9 Mail** (and Thunderbird for Android) | `.k9s` settings file | Copy it to the phone → Settings → *Import settings*. |
| **Apple Mail** (macOS, iPhone, iPad) | `.mobileconfig` profile | Open it on the Mac (System Settings → Profiles), or AirDrop it to the iPhone and install it under Settings → *Profile Downloaded*. Google and Microsoft OAuth accounts are skipped; add those with Apple Mail's built-in Google/Microsoft options. |
| **Evolution, KMail, FairEmail, Nextcloud Mail…** | Mozilla autoconfig `config-v1.1.xml` | Import it where the client supports that, or serve it at `autoconfig.<domain>/mail/config-v1.1.xml`. |
| **Anything else** (Outlook, eM Client, Mailspring…) | Plain-text settings sheet | Type the values in. |
| **Another HomeMail** | JSON backup | Import it on the other instance or user. |

## Importing from Thunderbird

*Settings → Export / import → From Thunderbird (prefs.js).* In Thunderbird, open *Help → Troubleshooting Information → Profile Folder → Open Folder* and choose `prefs.js` from that folder. Servers, names and signatures come across.

Thunderbird keeps passwords encrypted in its own store, so afterwards you enter them under *Mail accounts → Edit*. For Gmail and Outlook accounts that Thunderbird signs in to with OAuth, click *Reconnect*. Thunderbird also signs in to Yahoo/AOL with OAuth; for those, HomeMail needs an app password.

---

## Security notes

- Mail passwords and OAuth tokens are encrypted at rest (AES-256-GCM, key derived from `APP_SECRET`). User passwords are hashed with scrypt. Login attempts are rate-limited.
- Email HTML is sanitised and rendered in a sandboxed, script-free iframe. Remote images, fonts and styles are blocked until you click *Show* (or trust the sender), the same way Thunderbird handles remote content.
- Attachments always download rather than render on HomeMail's own origin.
- A mail client must connect wherever its user points it, so any HomeMail user can make the server open IMAP/POP3/SMTP connections to arbitrary hosts and ports. Only give accounts to people you trust, and keep open registration off on anything reachable from the internet.
- The built-in SMTP server accepts mail only for existing users on the mail domain, never relays, and has no spam filtering. Put it behind Stalwart, or keep port 25 closed, if spam is a concern.
- With federation on, anyone on the XMPP network can message your users and see whether they are online (users can delete unwanted conversations).
- Pictures pasted into a message are sent as inline attachments, and message HTML is sanitised before sending.
- If `APP_SECRET` is not set, HomeMail generates one into the data volume and warns you. That is convenient, but the key then sits next to the data it protects. Set it explicitly for real use.

## Keyboard shortcuts

Mail: `j`/`k` or ↓/↑ next/previous message · `Enter` open in a tab · `r` reply · `a` reply all · `f` forward · `c` write · `s` star · `u` toggle read · `Del` delete · `Ctrl+Enter` send · `Ctrl+S` save draft · `Enter` sends a chat message (`Shift+Enter` for a new line).

Calendar: `n` new event · `t` today · ←/→ previous/next · `d` day · `x` work week · `w` week · `m` month. Drag across the time grid to create an event; right-click an event or calendar for more.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example).

## Development

Requires Node.js 22+ (24 LTS recommended).

```bash
npm install
npm run dev          # API on :3000 (tsx watch) + Vite on :5173 with /api proxied
npm run typecheck
npm run build        # web/dist + server/dist; then: npm start
```

End-to-end tests (needs Docker): `./scripts/e2e.sh` starts throwaway [GreenMail](https://greenmail-mail-test.github.io/greenmail/), Stalwart and Prosody containers and a fresh HomeMail for each suite, then cleans up:

| Suite | Covers |
|---|---|
| `e2e-greenmail` | the mail client against IMAP, POP3 and SMTP; exports and imports |
| `e2e-server` | the built-in mail server (local delivery, inbound SMTP, relay with DKIM, queue), chat, admin settings |
| `e2e-stalwart` | mailbox provisioning, sending and app passwords on Stalwart |
| `e2e-xmpp` | federation: a user on another XMPP domain chatting with a HomeMail user |

Run one with e.g. `./scripts/e2e.sh e2e-xmpp`.

### VS Code

Open the folder in VS Code:

- **Run and Debug → "Full stack (server + web)"** (F5) starts the API under the debugger with breakpoints in `server/src`, starts Vite, and opens Chrome on http://localhost:5173 with breakpoints in `web/src`. Dev data goes to `./data`, and `.env` is loaded if present.
- **Terminal → Run Task…** offers `dev: server + web` (no debugger), `build` (Ctrl+Shift+B), `start (production build)`, `typecheck`, `test: e2e (Docker)`, and `docker: compose up / logs / down`.

Layout: `server/src` (Express API: `calendar/` holds the iCalendar handling and the CalDAV, Google, Microsoft and `.ics` drivers; `mail/` holds the IMAP backend via imapflow, a small POP3 client, the local store, SMTP via nodemailer and message rendering; `mailserver/` the built-in server and Stalwart provisioning; `chat/` chat and the XMPP gateway; `export/` and `import/` the format converters), `web/src` (React UI) and `deploy/` (Stalwart and Prosody configs).

## Known limitations

- IMAP is used live, with no offline cache, so search uses the server's IMAP SEARCH and new mail is picked up by polling every 60 s rather than IDLE push.
- Not yet implemented: conversation threading, an address book or contact autocomplete, meeting invitations (attendees, replying to invites from email), event reminders, dragging events to move them, PGP/S-MIME, message filters, moving messages between accounts, HTML signatures, file sharing in chat, federated group chats, logging in to your chat address from an XMPP app.
- The built-in mail server keeps mailboxes inside HomeMail (no IMAP for other apps) and has no spam filter; use Stalwart for either.
- POP3 downloads at most 500 new messages per check (newest first). The rest follow on later checks.
- Calendar sync was tested against Radicale (CalDAV) and `.ics` feeds. The Google Calendar and Microsoft Graph drivers were tested against recorded-style API responses, not the live services. iCloud, Fastmail and the other CalDAV providers use the same protocol as Radicale but were not exercised from this build.
- Tested with GreenMail (IMAP, POP3, SMTP, TLS, STARTTLS and plain). Gmail, Outlook and the other real providers use the same standard protocols but have not been exercised from this build. The Google and Microsoft sign-in flows need registered apps, so they are untested end to end.
- Stalwart (v0.16.23) and Prosody (13.0) were tested in Docker on this build, including federation between two XMPP domains on one Prosody. Federation with the public XMPP network and mail to and from the internet depend on your DNS, ports and certificates and were not tested.
- The Thunderbird `prefs.js` was verified by loading it into a Thunderbird 140 ESR profile. The QR and `.k9s` formats were checked against the Thunderbird for Android source code, not on a phone.
