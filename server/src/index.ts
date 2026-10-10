import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { db } from './db.js';
import { loadUser, requireCsrfHeader } from './auth.js';
import { HttpError, errorHandler } from './http.js';
import { authRouter } from './routes/auth.js';
import { accountsRouter } from './routes/accounts.js';
import { mailRouter } from './routes/mail.js';
import { transferRouter } from './routes/transfer.js';
import { syncPop3 } from './mail/local.js';
import { chatRouter } from './routes/chat.js';
import { serverRouter } from './routes/server.js';
import { startXmpp } from './chat/xmpp.js';
import { startBuiltinSmtp } from './mailserver/builtin.js';
import { syncAllMailboxes } from './mailserver/provision.js';

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        // Email HTML is rendered in sandboxed srcdoc iframes, which inherit this policy;
        // each iframe adds its own stricter policy that blocks remote content until allowed.
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
        'font-src': ["'self'", 'data:', 'https:'],
        'frame-src': ["'self'", 'blob:'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'self'"],
        // Many homelab setups serve plain HTTP on the LAN; don't force https subresources.
        'upgrade-insecure-requests': null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  }),
);

app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(loadUser);

const api = express.Router();
api.use(requireCsrfHeader);
api.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
api.use(authRouter, accountsRouter, mailRouter, transferRouter, chatRouter, serverRouter);
api.use((_req, _res, next) => next(new HttpError(404, 'Unknown API endpoint')));
app.use('/api', api);

app.get('/healthz', (_req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true });
});

if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
  app.use(express.static(config.webDir, { index: false, maxAge: '1h' }));
  // Single-page app: every other GET serves index.html.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(config.webDir, 'index.html'));
  });
} else {
  console.warn(`[web] No frontend build at ${config.webDir}; run "npm run build -w web" (or use the Vite dev server).`);
}

app.use(errorHandler);

/** Like Thunderbird's "check for new messages every N minutes", for POP3 accounts. */
const pollMinutes = Number(process.env.POP3_POLL_MINUTES || 10);
if (pollMinutes > 0) {
  setInterval(() => {
    const ids = db.prepare("SELECT id FROM accounts WHERE protocol = 'pop3'").pluck().all() as number[];
    (async () => {
      for (const id of ids) await syncPop3(id).catch(() => {});
    })();
  }, pollMinutes * 60_000).unref();
}

const server = app.listen(config.port, config.host, () => {
  console.log(`HomeMail listening on http://${config.host}:${config.port} (public URL: ${config.publicUrl})`);
});

// Background services; each logs its own problems and never stops the web app from starting.
startBuiltinSmtp().catch((e) => console.warn('[mailserver]', e.message));
syncAllMailboxes().catch((e) => console.warn('[mailserver]', e.message));
startXmpp().catch((e) => console.warn('[xmpp]', e.message));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
