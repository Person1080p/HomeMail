// Chat federation test: a user on another XMPP domain talks to a HomeMail user.
// Needs Prosody with the HomeMail component (see scripts/e2e.sh) and a test account
// dave@other.test reachable at XMPP_C2S (default xmpp://127.0.0.1:15222).
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { client, xml } = await import(require.resolve('@xmpp/client'));

const BASE = process.env.BASE || 'http://localhost:3311';
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);
  if (!c) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
async function call(method, path, body) {
  const res = await fetch(BASE + '/api' + path, { method, headers: { 'x-homemail': '1', 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('homemail_sid=')) cookie = c.split(';')[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}

await call('POST', '/auth/register', { username: 'alice', password: 'correct horse battery' });
let r = await call('GET', '/admin/server');
for (let i = 0; i < 20 && r.json.xmpp?.status !== 'online'; i++) {
  await sleep(500);
  r = await call('GET', '/admin/server');
}
ok(r.json.chatFederation && r.json.xmpp?.status === 'online', 'HomeMail is connected to Prosody as home.mail: ' + JSON.stringify(r.json.xmpp));

const dave = client({ service: process.env.XMPP_C2S || 'xmpp://127.0.0.1:15222', domain: 'other.test', username: 'dave', password: 'davepass', resource: 'test' });
const inbox = [];
dave.on('stanza', (s) => inbox.push(s));
dave.on('error', (e) => console.log('dave error', e.message));
await dave.start();
await dave.send(xml('presence'));
const waitFor = async (pred, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const hit = inbox.find(pred);
    if (hit) return hit;
  }
  return null;
};

// disco on the domain and on a user
const disco = await dave.iqCaller.request(xml('iq', { type: 'get', to: 'home.mail' }, xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' })));
ok(disco.getChild('query').getChild('identity')?.attrs.name === 'HomeMail', 'disco#info on home.mail answers as HomeMail');
const userDisco = await dave.iqCaller.request(xml('iq', { type: 'get', to: 'alice@home.mail' }, xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' })));
ok(userDisco.getChild('query').getChild('identity')?.attrs.category === 'account', 'disco#info on alice@home.mail is an account');

// presence subscription
await dave.send(xml('presence', { type: 'subscribe', to: 'alice@home.mail' }));
// Dave's server turns the "subscribed" answer into a roster update; what Dave sees is alice's presence.
ok(!!(await waitFor((s) => s.is('presence') && s.attrs.from?.startsWith('alice@home.mail/'))), 'subscription approved: dave receives alice\'s presence');

// incoming message
await dave.send(xml('message', { type: 'chat', to: 'alice@home.mail', id: 'm1' }, xml('body', {}, 'Hi Alice, from another server!')));
let convs;
for (let i = 0; i < 20; i++) {
  convs = (await call('GET', '/chat/conversations')).json;
  if (convs.length) break;
  await sleep(250);
}
const dm = convs[0];
ok(dm?.remote && dm.title === 'dave@other.test' && dm.unread === 1, 'message from dave@other.test shows up as a DM: ' + JSON.stringify(dm && { title: dm.title, unread: dm.unread }));
const msgs = (await call('GET', `/chat/conversations/${dm.id}/messages`)).json;
ok(msgs[0]?.body === 'Hi Alice, from another server!' && msgs[0].senderJid === 'dave@other.test', 'message body and sender');
// duplicate stanza id is ignored
await dave.send(xml('message', { type: 'chat', to: 'alice@home.mail', id: 'm1' }, xml('body', {}, 'Hi Alice, from another server!')));
await sleep(500);
ok((await call('GET', `/chat/conversations/${dm.id}/messages`)).json.length === 1, 'redelivered stanza is not duplicated');

// reply from HomeMail
r = await call('POST', `/chat/conversations/${dm.id}/messages`, { body: 'Hello Dave 👋' });
ok(r.status === 200, 'alice replies');
const reply = await waitFor((s) => s.is('message') && s.getChildText('body') === 'Hello Dave 👋');
ok(reply?.attrs.from?.startsWith('alice@home.mail/'), 'dave receives the reply from alice@home.mail');

// typing
await call('POST', `/chat/conversations/${dm.id}/typing`, { active: true });
ok(!!(await waitFor((s) => s.is('message') && s.getChild('composing', 'http://jabber.org/protocol/chatstates'))), 'dave sees alice typing');

// starting a chat from HomeMail with a remote address
r = await call('POST', '/chat/dm', { address: 'dave@other.test' });
ok(r.json.id === dm.id, 'opening dave@other.test from HomeMail reuses the DM');

// unknown local user
await dave.send(xml('message', { type: 'chat', to: 'nobody@home.mail', id: 'm2' }, xml('body', {}, 'hello?')));
const err = await waitFor((s) => s.is('message') && s.attrs.type === 'error' && s.attrs.id === 'm2');
ok(!!err?.getChild('error')?.getChild('item-not-found'), 'messages to unknown users bounce with item-not-found');

await dave.stop();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
