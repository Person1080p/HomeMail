# HomeMail

A self-hosted, multi-user webmail client in the spirit of Thunderbird, built for homelabs.

- **Multiple users**: each with their own login and their own set of mail accounts. The first user becomes the admin; admins add users (or open registration).
- **Many accounts per user** in one three-pane view (folders | messages | reader), with unread counts, search, stars, drag-and-drop to folders, drafts, attachments, rich-text compose, signatures, keyboard shortcuts, dark mode and a phone layout.
- **Providers**: Gmail, Outlook.com/Hotmail, Microsoft 365, Yahoo, AOL, iCloud (Apple), Proton Mail (through Proton Mail Bridge), Fastmail, Zoho, GMX, and any IMAP or POP3 server. Settings are detected from the email address the way Thunderbird does it (built-in presets, MX lookup, Mozilla ISPDB).
- **Export** a user's accounts to Thunderbird, Thunderbird for Android (QR codes), K-9 Mail, Apple Mail (macOS/iOS), Mozilla autoconfig XML (Evolution, KMail, FairEmail…), a printable settings sheet, or a HomeMail backup.
- **Import** accounts from your existing Thunderbird (`prefs.js`) or a HomeMail backup.

> **Tuta (Tutanota) cannot be supported.** Tuta offers no IMAP, POP3 or SMTP access and no bridge, so no third-party client (Thunderbird included) can connect to it. HomeMail shows this when you pick Tuta. Your options are Tuta's own apps, or forwarding Tuta mail to another mailbox.

---

## Quick start (Docker Compose)

```bash
cp .env.example .env
# Set APP_SECRET (openssl rand -base64 48) and PUBLIC_URL in .env
docker compose up -d --build
```

Open `PUBLIC_URL` (default http://localhost:3000) and create the first user. That user is the administrator.

Mail data lives in the `homemail-data` volume (SQLite database plus downloaded POP3 mail). **Back up both that volume and your `APP_SECRET`**: stored mail passwords and OAuth tokens are encrypted with it.

### HTTPS / reverse proxy

Put HomeMail behind your usual reverse proxy (Caddy, Traefik, nginx, NPM…) and set `PUBLIC_URL=https://mail.your.domain`. With an `https` URL, session cookies are marked `Secure`. By default, proxies on loopback and private networks are trusted for `X-Forwarded-*` headers (`TRUST_PROXY`).

HomeMail does **not** need to be reachable from the internet, even for Google/Microsoft sign-in. Those redirects happen in your browser. It does need HTTPS and a real domain name (one that resolves on your LAN is fine; Let's Encrypt DNS challenge works well).

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

IMAP accounts work directly against the server, so nothing is copied into HomeMail. POP3 accounts download mail into HomeMail's data volume. "Leave messages on the server" is on by default, and new mail is checked every `POP3_POLL_MINUTES`.

---

## Admin setup: Sign in with Google / Microsoft (optional)

Both flows use the redirect URI `PUBLIC_URL/api/oauth/<provider>/callback`. The admin page in HomeMail shows the exact URIs.

### Google

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project.
2. Open **Google Auth Platform**. Set up branding with user type **External**. Under *Data access*, add the scope `https://mail.google.com/`.
3. Under **Clients**, create an OAuth client of type **Web application**. Add the redirect URI `https://mail.your.domain/api/oauth/google/callback`.
4. Under **Audience**, set the publishing status to **In production**. Apps left in *Testing* get refresh tokens that expire after 7 days. For personal use the app can stay unverified; people see a "Google hasn't verified this app" warning and click *Advanced → continue*. Unverified apps are limited to 100 users.
5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env` and restart.

### Microsoft (Outlook.com, Hotmail, Microsoft 365)

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), go to *App registrations* → **New registration**. A free Azure account works for personal use.
2. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
3. Redirect URI: platform **Web**, `https://mail.your.domain/api/oauth/microsoft/callback`.
4. Under *Certificates & secrets*, create a client secret and copy its **value**.
5. Under *API permissions*, add these Microsoft Graph delegated permissions: `IMAP.AccessAsUser.All`, `POP.AccessAsUser.All`, `SMTP.Send`, `offline_access`, `openid`, `email`, `profile`.
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
- If `APP_SECRET` is not set, HomeMail generates one into the data volume and warns you. That is convenient, but the key then sits next to the data it protects. Set it explicitly for real use.

## Keyboard shortcuts

`j`/`k` or ↓/↑ next/previous message · `r` reply · `a` reply all · `f` forward · `c` write · `s` star · `u` toggle read · `Del` delete · `Ctrl+Enter` send.

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

End-to-end test against a throwaway [GreenMail](https://greenmail-mail-test.github.io/greenmail/) server (it accepts any password):

```bash
docker run -d --rm --name greenmail -p 3025:3025 -p 3110:3110 -p 3143:3143 -p 3465:3465 -p 3993:3993 -p 3995:3995 \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=alice:alicepass@example.test,bob:bobpass@example.test -Dgreenmail.users.login=email' \
  greenmail/standalone:2.1.3
DATA_DIR=$(mktemp -d) PORT=3311 npm run dev -w server &
node scripts/e2e-greenmail.mjs
```

Layout: `server/src` (Express API: `mail/` holds the IMAP backend via imapflow, a small POP3 client, the local store, SMTP via nodemailer and message rendering; `export/` and `import/` hold the format converters) and `web/src` (React UI).

## Known limitations

- IMAP is used live, with no offline cache, so search uses the server's IMAP SEARCH and new mail is picked up by polling every 60 s rather than IDLE push.
- Not yet implemented: conversation threading, an address book or contact autocomplete, calendars, PGP/S-MIME, message filters, moving messages between accounts, more than one compose window, HTML signatures.
- POP3 downloads at most 500 new messages per check (newest first). The rest follow on later checks.
- Tested with GreenMail (IMAP, POP3, SMTP, TLS, STARTTLS and plain). Gmail, Outlook and the other real providers use the same standard protocols but have not been exercised from this build. The Google and Microsoft sign-in flows need registered apps, so they are untested end to end.
- The Thunderbird `prefs.js` was verified by loading it into a Thunderbird 140 ESR profile. The QR and `.k9s` formats were checked against the Thunderbird for Android source code, not on a phone.
