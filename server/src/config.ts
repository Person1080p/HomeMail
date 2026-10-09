import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));

const dataDir = path.resolve(env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });

/**
 * The app secret encrypts stored mail credentials. Prefer providing it via the
 * APP_SECRET env var so it doesn't live on the same volume as the database.
 */
function loadSecret(): string {
  if (env.APP_SECRET) {
    if (env.APP_SECRET.length < 32) throw new Error('APP_SECRET must be at least 32 characters long');
    return env.APP_SECRET;
  }
  const file = path.join(dataDir, 'app-secret.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  console.warn(
    `[config] APP_SECRET is not set. Generated one and stored it in ${file}. ` +
      'Back it up: without it, stored mail passwords and tokens cannot be decrypted.',
  );
  return secret;
}

function parseTrustProxy(v: string | undefined): boolean | number | string {
  if (v === undefined || v === '') return 'loopback,uniquelocal';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

const port = Number(env.PORT || 3000);
const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');

export const config = {
  port,
  host: env.HOST || '0.0.0.0',
  dataDir,
  mailDir: path.join(dataDir, 'mail'),
  secret: loadSecret(),
  publicUrl,
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : publicUrl.startsWith('https://'),
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  /** Default for open self-registration; admins can change it at runtime. */
  allowRegistration: env.ALLOW_REGISTRATION === 'true',
  sessionDays: Number(env.SESSION_DAYS || 30),
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 25),
  google: env.GOOGLE_CLIENT_ID
    ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET || '' }
    : null,
  microsoft: env.MICROSOFT_CLIENT_ID
    ? {
        clientId: env.MICROSOFT_CLIENT_ID,
        clientSecret: env.MICROSOFT_CLIENT_SECRET || '',
        tenant: env.MICROSOFT_TENANT || 'common',
      }
    : null,
  /** Look up unknown domains in Mozilla's ISPDB / autoconfig, like Thunderbird does. */
  autodetectOnline: env.AUTODETECT_ONLINE !== 'false',
  webDir: path.resolve(env.WEB_DIR || path.join(here, '../../web/dist')),
};

fs.mkdirSync(config.mailDir, { recursive: true });
