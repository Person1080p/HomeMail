// Stalwart mode: HomeMail provisions mailboxes on a bundled Stalwart server.
// Needs Stalwart started with deploy/stalwart/config.json and HomeMail in MAIL_SERVER_MODE=stalwart
// with MAIL_DOMAIN=home.internal (see scripts/e2e.sh).
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { ImapFlow } = require('imapflow');

const BASE = process.env.BASE || 'http://localhost:3311';
const IMAP_PORT = Number(process.env.STALWART_IMAP_PORT || 30993);
const jars = {};
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);
  if (!c) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(who, method, path, body, form) {
  const h = { 'x-homemail': '1', cookie: jars[who] ?? '' };
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(BASE + '/api' + path, { method, headers: h, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('homemail_sid=')) jars[who] = c.split(';')[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function imapLogin(user, pass) {
  const c = new ImapFlow({ host: '127.0.0.1', port: IMAP_PORT, secure: true, auth: { user, pass }, logger: false, tls: { rejectUnauthorized: false } });
  c.on('error', () => {});
  try {
    await c.connect();
    await c.logout();
    return true;
  } catch {
    return false;
  }
}

await call('a', 'POST', '/auth/register', { username: 'alice', password: 'correct horse battery' });
let r = await call('a', 'GET', '/me/addresses');
ok(r.json.mailbox.mode === 'stalwart' && r.json.mailbox.address === 'alice@home.internal' && !r.json.mailbox.error, 'alice gets alice@home.internal on Stalwart: ' + JSON.stringify(r.json.mailbox));
ok(r.json.mailbox.clients?.imap.host === 'mail.home.internal' && r.json.mailbox.clients.imap.port === 993, 'settings for other apps use the public host name');
const aliceBox = r.json.mailbox.accountId;
r = await call('a', 'GET', '/admin/server');
ok(r.json.stalwart.ok && /MX 10 mail\.home\.internal/.test(r.json.stalwart.dnsZone ?? ''), 'admin sees Stalwart status and the DNS records to publish');

await call('a', 'POST', '/admin/users', { username: 'bob', password: 'another long password' });
await call('b', 'POST', '/auth/login', { username: 'bob', password: 'another long password' });
const bobBox = (await call('b', 'GET', '/me/addresses')).json.mailbox.accountId;
ok(!!bobBox, 'bob gets a Stalwart mailbox on creation');

r = await call('a', 'GET', `/accounts/${aliceBox}/folders`);
ok(r.status === 200 && r.json.some((f) => f.specialUse === '\\Sent'), 'HomeMail reads alice\'s Stalwart folders over IMAP');
const fd = new FormData();
fd.append('payload', JSON.stringify({ to: 'bob@home.internal', subject: 'via stalwart', text: 'hi bob' }));
r = await call('a', 'POST', `/accounts/${aliceBox}/send`, undefined, fd);
ok(r.status === 200, 'alice sends through Stalwart: ' + JSON.stringify(r.json));
let got = false;
for (let i = 0; i < 20 && !got; i++) {
  await sleep(500);
  r = await call('b', 'GET', `/accounts/${bobBox}/messages?folder=INBOX`);
  got = r.json.messages?.some((m) => m.subject === 'via stalwart');
}
ok(got, 'bob receives it in his Stalwart inbox');

r = await call('a', 'POST', '/me/mailbox-password');
const pw = r.json.password;
ok(typeof pw === 'string' && pw.length >= 20, 'alice gets a new mailbox password for other apps');
ok(await imapLogin('alice@home.internal', pw), 'that password works for IMAP from other apps');
r = await call('a', 'GET', `/accounts/${aliceBox}/folders`);
ok(r.status === 200, 'HomeMail still connects after the password change');

const bobId = (await call('a', 'GET', '/admin/users')).json.find((u) => u.username === 'bob').id;
r = await call('a', 'DELETE', `/admin/users/${bobId}`);
ok(r.status === 200, 'admin deletes bob');
const sw = await fetch(`${process.env.STALWART_URL || 'http://127.0.0.1:38080'}/jmap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(process.env.STALWART_ADMIN || 'admin:Recovery-Secret-123').toString('base64') },
  body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: [['x:Account/query', { filter: { name: 'bob' } }, 'q']] }),
}).then((x) => x.json());
ok(sw.methodResponses[0][1].ids.length === 0, 'bob\'s Stalwart mailbox was removed');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
