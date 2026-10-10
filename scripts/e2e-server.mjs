// End-to-end tests for HomeMail's own services: built-in mail server, chat and admin settings.
// Needs a fresh HomeMail (built-in mail mode, SMTP on BUILTIN_SMTP_PORT) and GreenMail as the outbound relay.
// Run through scripts/e2e.sh.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');

const BASE = process.env.BASE || 'http://localhost:3311';
const SMTP_PORT = Number(process.env.BUILTIN_SMTP_PORT || 2525);
const jars = {};
let fails = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(who, method, path, body, { form } = {}) {
  const h = { 'x-homemail': '1' };
  if (jars[who]) h.cookie = jars[who];
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + '/api' + path, { method, headers: h, body: payload });
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('homemail_sid=')) jars[who] = c.split(';')[0];
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** Collects Server-Sent Events for a user. */
function listen(who) {
  const events = [];
  const ctrl = new AbortController();
  (async () => {
    const res = await fetch(BASE + '/api/events', { headers: { cookie: jars[who] }, signal: ctrl.signal });
    const reader = res.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev) events.push({ event: ev, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
  return {
    events,
    stop: () => ctrl.abort(),
    async waitFor(pred, ms = 5000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = events.find(pred);
        if (hit) return hit;
        await sleep(50);
      }
      return null;
    },
  };
}

const send = (who, accountId, payload) => {
  const fd = new FormData();
  fd.append('payload', JSON.stringify(payload));
  return call(who, 'POST', `/accounts/${accountId}/send`, undefined, { form: fd });
};

/* ---------- users and mailboxes ---------- */

let r = await call('a', 'POST', '/auth/register', { username: 'alice', password: 'correct horse battery' });
ok(r.status === 200, 'admin registers');
r = await call('a', 'POST', '/admin/users', { username: 'bob', password: 'another long password' });
ok(r.status === 200, 'admin creates bob');
r = await call('a', 'POST', '/admin/users', { username: 'bad@name', password: 'another long password' });
ok(r.status === 400, 'usernames may not contain @');
await call('b', 'POST', '/auth/login', { username: 'bob', password: 'another long password' });

r = await call('a', 'GET', '/me/addresses');
ok(r.json.chat.address === 'alice@home.mail' && r.json.mailbox.address === 'alice@home.mail' && r.json.mailbox.mode === 'builtin', 'alice has alice@home.mail for chat and mail');
const aliceBox = r.json.mailbox.accountId;
const bobBox = (await call('b', 'GET', '/me/addresses')).json.mailbox.accountId;
r = await call('a', 'GET', '/accounts');
ok(r.json[0].managed === 'builtin' && r.json[0].protocol === 'local', 'built-in mailbox listed first in accounts');
r = await call('a', 'DELETE', `/accounts/${aliceBox}`);
ok(r.status === 400, 'built-in mailbox cannot be deleted');
r = await call('a', 'GET', `/accounts/${aliceBox}/folders`);
ok(r.json.map((f) => f.path).join() === 'INBOX,Drafts,Sent,Trash', 'built-in mailbox folders');

/* ---------- local delivery ---------- */

const bobEvents = listen('b');
await sleep(300);
r = await send('a', aliceBox, { to: 'Bob <bob@home.mail>', subject: 'local hello', text: 'hi bob' });
ok(r.status === 200, 'alice sends to bob@home.mail');
ok(!!(await bobEvents.waitFor((e) => e.event === 'mail.new' && e.data.accountId === bobBox)), 'bob gets a live new-mail event');
r = await call('b', 'GET', `/accounts/${bobBox}/messages?folder=INBOX`);
ok(r.json.messages[0]?.subject === 'local hello', 'message is in bob\'s inbox');
r = await call('a', 'GET', `/accounts/${aliceBox}/messages?folder=Sent`);
ok(r.json.messages[0]?.subject === 'local hello', 'copy in alice\'s Sent');
// A pasted picture (data: URL) goes out as a cid: attachment; importance and read receipt set headers.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
r = await send('a', aliceBox, { to: 'bob@home.mail', subject: 'picture', text: 'see picture', html: `<p>see <img src="data:image/png;base64,${png}"></p>`, priority: 'high', readReceipt: true });
ok(r.status === 200, 'send with an inline picture');
r = await call('b', 'GET', `/accounts/${bobBox}/messages?folder=INBOX&q=picture`);
const picId = r.json.messages[0]?.id;
const rawPic = await fetch(`${BASE}/api/accounts/${bobBox}/messages/${picId}/raw?folder=INBOX`, { headers: { cookie: jars.b } }).then((x) => x.text());
ok(/src="cid:img1\.[0-9a-f]+@homemail"/.test(rawPic) && /Content-ID: <img1\./i.test(rawPic) && !/src="data:/.test(rawPic), 'inline picture sent as a cid: attachment');
ok(/^X-Priority: 1/m.test(rawPic) && /^Disposition-Notification-To: alice@home\.mail/m.test(rawPic), 'importance and read-receipt headers');
r = await call('b', 'GET', `/accounts/${bobBox}/messages/${picId}?folder=INBOX`);
ok(/<img src="data:image\/png;base64,/.test(r.json.html) && r.json.attachments.every((a) => a.inline), 'recipient sees the picture inline, not as a separate attachment');
r = await send('a', aliceBox, { to: 'nobody@home.mail', subject: 'x', text: 'x' });
ok(r.status === 400 && /no mailbox/i.test(r.json.error), 'unknown local recipient rejected: ' + r.json.error);

/* ---------- inbound SMTP ---------- */

const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: SMTP_PORT, secure: false, ignoreTLS: true, name: 'sender.example.test' });
r = await smtp.sendMail({ from: 'stranger@example.test', to: 'bob@home.mail', subject: 'from outside', text: 'hello from the internet' }).catch((e) => e);
ok(r.accepted?.includes('bob@home.mail'), 'inbound SMTP accepts mail for bob@home.mail');
r = await smtp.sendMail({ from: 'stranger@example.test', to: 'victim@gmail.com', subject: 'relay?', text: 'x' }).catch((e) => e);
ok(r.responseCode === 550, 'inbound SMTP refuses to relay to other domains');
r = await smtp.sendMail({ from: 'stranger@example.test', to: 'nobody@home.mail', subject: 'x', text: 'x' }).catch((e) => e);
ok(r.responseCode === 550, 'inbound SMTP rejects unknown users');
await sleep(300);
r = await call('b', 'GET', `/accounts/${bobBox}/messages?folder=INBOX`);
const outside = r.json.messages.find((m) => m.subject === 'from outside');
ok(!!outside, 'mail from outside is in bob\'s inbox');
r = await call('b', 'GET', `/accounts/${bobBox}/messages/${outside.id}?folder=INBOX`);
ok(r.json.text.includes('hello from the internet'), 'inbound message body intact');

/* ---------- outbound via relay (GreenMail) with DKIM ---------- */

r = await call('a', 'GET', '/admin/server');
ok(r.json.mailMode === 'builtin' && r.json.builtin.smtp.listening, 'admin sees built-in mode with SMTP listening');
ok(r.json.builtin.dns.some((d) => /_domainkey/.test(d.name) && /p=MII/.test(d.value)), 'DKIM DNS record offered');
r = await call('a', 'PUT', '/admin/server', { outboundMode: 'relay', relay: { host: '127.0.0.1', port: 3025, security: 'none', username: '' } });
ok(r.status === 200 && r.json.outboundMode === 'relay', 'switch outbound to relay');
r = await send('a', aliceBox, { to: 'alice@example.test', subject: 'to the outside world', text: 'over the relay' });
ok(r.status === 200, 'send to external address');
let delivered = null;
for (let i = 0; i < 20 && !delivered; i++) {
  await sleep(500);
  const c = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, doSTARTTLS: false, auth: { user: 'alice@example.test', pass: 'alicepass' }, logger: false });
  await c.connect();
  const lock = await c.getMailboxLock('INBOX');
  for await (const m of c.fetch('1:*', { envelope: true, source: true })) if (m.envelope.subject === 'to the outside world') delivered = m.source.toString();
  lock.release();
  await c.logout();
}
ok(!!delivered, 'relay delivered to the external mailbox');
ok(/^DKIM-Signature:.*d=home\.mail.*s=homemail/ms.test(delivered ?? ''), 'outgoing mail is DKIM-signed for home.mail');
r = await call('a', 'GET', '/admin/server');
ok(r.json.builtin.queue.length === 0, 'outbound queue empty after delivery');

// A relay that is down: the message stays queued for retry.
await call('a', 'PUT', '/admin/server', { relay: { host: '127.0.0.1', port: 9, security: 'none', username: '' } });
await send('a', aliceBox, { to: 'someone@example.test', subject: 'will wait', text: 'x' });
await sleep(1500);
r = await call('a', 'GET', '/admin/server');
const queued = r.json.builtin.queue[0];
ok(queued && queued.attempts >= 1 && queued.lastError, 'failed delivery is queued with an error: ' + queued?.lastError);
r = await call('a', 'DELETE', `/admin/server/queue/${queued.id}`);
r = await call('a', 'GET', '/admin/server');
ok(r.json.builtin.queue.length === 0, 'admin can drop a queued message');
r = await call('a', 'PUT', '/admin/server', { outboundMode: 'off' });
r = await send('a', aliceBox, { to: 'someone@example.test', subject: 'x', text: 'x' });
ok(r.status === 400 && /turned off/.test(r.json.error), 'outbound off blocks external recipients');

/* ---------- chat ---------- */

const aliceEvents = listen('a');
await sleep(300);
r = await call('a', 'GET', '/chat/directory');
ok(r.json.some((u) => u.username === 'bob' && u.online && u.address === 'bob@home.mail'), 'directory shows bob online');
r = await call('a', 'POST', '/chat/dm', { address: 'bob@home.mail' });
const dm = r.json;
ok(dm.kind === 'dm' && dm.title === 'bob', 'alice opens a DM with bob@home.mail');
r = await call('a', 'POST', '/chat/dm', { address: 'bob' });
ok(r.json.id === dm.id, 'same DM is reused');
r = await call('a', 'POST', '/chat/dm', { address: 'someone@jabber.example' });
ok(r.status === 400 && /turned off/.test(r.json.error), 'remote addresses rejected while federation is off');
r = await call('a', 'POST', '/chat/dm', { address: 'ghost@home.mail' });
ok(r.status === 404, 'unknown local user');

r = await call('a', 'POST', `/chat/conversations/${dm.id}/typing`, { active: true });
ok(!!(await bobEvents.waitFor((e) => e.event === 'chat.typing' && e.data.conversationId === dm.id && e.data.active)), 'bob sees alice typing');
r = await call('a', 'POST', `/chat/conversations/${dm.id}/messages`, { body: 'Hello Bob! 👋' });
const msg = r.json;
ok(!!(await bobEvents.waitFor((e) => e.event === 'chat.message' && e.data.id === msg.id && e.data.body === 'Hello Bob! 👋')), 'bob receives the message live');
r = await call('b', 'GET', '/chat/conversations');
ok(r.json[0]?.id === dm.id && r.json[0].unread === 1 && r.json[0].title === 'alice', 'bob has 1 unread in the DM');
await call('b', 'POST', `/chat/conversations/${dm.id}/read`, { messageId: msg.id });
ok(!!(await aliceEvents.waitFor((e) => e.event === 'chat.read' && e.data.userId !== undefined)), 'alice sees the read receipt');
r = await call('b', 'GET', '/chat/conversations');
ok(r.json[0].unread === 0, 'unread cleared');
r = await call('b', 'GET', `/chat/conversations/${dm.id}/messages`);
ok(r.json.length === 1 && r.json[0].senderUserId !== null, 'history available');
r = await call('b', 'DELETE', `/chat/messages/${msg.id}`);
ok(r.status === 404, 'bob cannot delete alice\'s message');

r = await call('a', 'POST', '/admin/users', { username: 'carol', password: 'carol long password' });
const carolId = r.json.id;
const bobId = (await call('a', 'GET', '/chat/directory')).json.find((u) => u.username === 'bob').userId;
r = await call('a', 'POST', '/chat/groups', { name: 'Family', members: [bobId, carolId] });
const group = r.json;
ok(group.kind === 'group' && group.members.length === 3, 'group created with 3 members');
ok(!!(await bobEvents.waitFor((e) => e.event === 'chat.conversation' && e.data.id === group.id)), 'bob is told about the new group');
r = await call('b', 'PATCH', `/chat/conversations/${group.id}`, { name: 'Hacked' });
ok(r.status === 403, 'only the owner renames');
await call('a', 'PATCH', `/chat/conversations/${group.id}`, { name: 'Family 🏠' });
await call('b', 'POST', `/chat/conversations/${group.id}/messages`, { body: 'hi all' });
r = await call('b', 'DELETE', `/chat/conversations/${group.id}/members/${bobId}`);
ok(r.status === 200, 'bob leaves the group');
r = await call('a', 'GET', `/chat/conversations/${group.id}/messages`);
ok(r.json.filter((m) => m.kind === 'system').length === 3 && r.json.some((m) => m.body === 'hi all'), 'group history has system notes and messages');
r = await call('b', 'GET', `/chat/conversations/${group.id}/messages`);
ok(r.status === 404, 'bob can no longer read the group');

bobEvents.stop();
ok(!!(await aliceEvents.waitFor((e) => e.event === 'presence' && e.data.userId === bobId && e.data.online === false)), 'alice sees bob go offline');
aliceEvents.stop();

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
