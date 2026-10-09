// End-to-end API test against a GreenMail server and a HomeMail instance with an empty DATA_DIR.
// See README "Development" for how to start both. Usage: node scripts/e2e-greenmail.mjs
const BASE = process.env.BASE || 'http://localhost:3311';
const jars = {};
let fails = 0;
function ok(cond, msg) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; }
async function call(who, method, path, body, { raw = false, headers = {}, form } = {}) {
  const h = { 'x-homemail': '1', ...headers };
  if (jars[who]) h.cookie = jars[who];
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
  const sc = res.headers.getSetCookie?.() || [];
  for (const c of sc) if (c.startsWith('homemail_sid=')) jars[who] = c.split(';')[0];
  if (raw) return res;
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let r = await call('a', 'GET', '/api/auth/state');
ok(r.json.needsSetup === true && r.json.user === null, 'fresh install needs setup');
r = await call('a', 'POST', '/api/auth/register', { username: 'alice', password: 'correct horse battery' });
ok(r.status === 200, 'first user registers');
r = await call('a', 'GET', '/api/auth/state');
ok(r.json.user?.isAdmin === true, 'first user is admin');
r = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { cookie: jars.a } });
ok(r.status === 403, 'CSRF header required for POST');
r = await call('x', 'POST', '/api/auth/register', { username: 'mallory', password: 'correct horse battery' });
ok(r.status === 403, 'registration closed after first user');
r = await call('x', 'POST', '/api/auth/login', { username: 'alice', password: 'wrong password!' });
ok(r.status === 401, 'wrong password rejected');

r = await call('a', 'POST', '/api/autodetect', { email: 'someone@gmail.com' });
ok(r.json.presetId === 'gmail', 'autodetect gmail');
r = await call('a', 'POST', '/api/autodetect', { email: 'someone@hotmail.co.uk' });
ok(r.json.presetId === 'outlook', 'autodetect hotmail.co.uk -> outlook');
r = await call('a', 'POST', '/api/autodetect', { email: 'x@tutanota.com' });
ok(r.json.presetId === 'tuta', 'autodetect tuta');

const imapAcc = {
  provider: 'imap', email: 'alice@example.test', displayName: 'Alice Ä', protocol: 'imap', label: 'Alice IMAP',
  incoming: { host: '127.0.0.1', port: 3993, security: 'tls', username: 'alice@example.test' },
  smtp: { host: '127.0.0.1', port: 3465, security: 'tls', username: 'alice@example.test' },
  password: 'alicepass', allowInsecureTls: true, signature: '-- \nAlice',
};
r = await call('a', 'POST', '/api/accounts/test', { ...imapAcc, allowInsecureTls: false });
ok(r.json.incoming && /self-signed/i.test(r.json.incoming), 'self-signed cert rejected unless allowed: ' + r.json.incoming);
r = await call('a', 'POST', '/api/accounts/test', { ...imapAcc, password: 'nope' });
// GreenMail accepts any password, so bad-password handling can't be tested here.
r = await call('a', 'POST', '/api/accounts/test', imapAcc);
ok(r.json.incoming === null && r.json.smtp === null, 'IMAP+SMTP test passes ' + JSON.stringify(r.json));
r = await call('a', 'POST', '/api/accounts', imapAcc);
const A = r.json.id; ok(A > 0 && r.json.hasPassword && !('password' in r.json), 'IMAP account created, no secret leaked');

const popAcc = {
  provider: 'pop3', email: 'bob@example.test', displayName: 'Bob', protocol: 'pop3', label: 'Bob POP',
  incoming: { host: '127.0.0.1', port: 3995, security: 'tls', username: 'bob@example.test' },
  smtp: { host: '127.0.0.1', port: 3025, security: 'none', username: 'bob@example.test' },
  password: 'bobpass', allowInsecureTls: true, leaveOnServer: true,
};
r = await call('a', 'POST', '/api/accounts/test', popAcc);
ok(r.json.incoming === null && r.json.smtp === null, 'POP3+SMTP test passes ' + JSON.stringify(r.json));
r = await call('a', 'POST', '/api/accounts/test', { ...popAcc, incoming: { ...popAcc.incoming, port: 3110, security: 'none' } });
ok(r.json.incoming === null, 'plain POP3 test passes ' + JSON.stringify(r.json));
r = await call('a', 'POST', '/api/accounts', popAcc);
const B = r.json.id; ok(B > 0, 'POP3 account created');

// send from alice to alice + bob, with attachment and html
const fd = new FormData();
fd.append('payload', JSON.stringify({ to: 'Alice <alice@example.test>, bob@example.test', subject: 'Hellö <test> 1', text: 'Hi there\n.\n..dots', html: '<p>Hi <b>there</b><script>alert(1)</script><img src="https://tracker.example/x.png"></p>' }));
fd.append('files', new Blob([Buffer.from('hello attachment')], { type: 'text/plain' }), 'nötes.txt');
r = await call('a', 'POST', `/api/accounts/${A}/send`, undefined, { form: fd });
ok(r.status === 200, 'send with attachment ' + JSON.stringify(r.json));
await sleep(800);

r = await call('a', 'GET', `/api/accounts/${A}/folders`);
ok(Array.isArray(r.json) && r.json[0].path === 'INBOX', 'folders listed, INBOX first: ' + r.json.map?.((f) => f.path + (f.specialUse || '')).join(','));
const sent = r.json.find((f) => f.specialUse === '\\Sent');
ok(sent && sent.total === 1, 'sent copy appended to Sent');
r = await call('a', 'GET', `/api/accounts/${A}/messages?folder=INBOX`);
ok(r.json.total === 1 && r.json.messages[0].subject === 'Hellö <test> 1' && r.json.messages[0].hasAttachments && !r.json.messages[0].seen, 'inbox lists message with attachment, unread');
const mid = r.json.messages[0].id;
r = await call('a', 'GET', `/api/accounts/${A}/messages/${mid}?folder=INBOX`);
ok(r.json.html && !/script/i.test(r.json.html) && r.json.hasRemoteContent, 'html sanitized, remote content detected');
ok(r.json.text.includes('\n.\n..dots'), 'dot lines preserved in text');
ok(r.json.attachments.length === 1 && r.json.attachments[0].filename === 'nötes.txt', 'attachment filename utf8: ' + r.json.attachments[0]?.filename);
ok(r.json.from[0].name === 'Alice Ä', 'from display name');
let res = await call('a', 'GET', `/api/accounts/${A}/messages/${mid}/attachments/0?folder=INBOX`, undefined, { raw: true });
ok((await res.text()) === 'hello attachment' && /attachment/.test(res.headers.get('content-disposition')) && res.headers.get('content-type').startsWith('application/octet-stream'), 'attachment download forced');
r = await call('a', 'GET', `/api/accounts/${A}/messages?folder=INBOX`);
ok(r.json.messages[0].seen === true, 'opening marks seen');
r = await call('a', 'POST', `/api/accounts/${A}/messages/flags`, { folder: 'INBOX', ids: [mid], seen: false, flagged: true });
r = await call('a', 'GET', `/api/accounts/${A}/messages?folder=INBOX&flagged=1`);
ok(r.json.total === 1 && r.json.messages[0].flagged && !r.json.messages[0].seen, 'flag + unread filter search');
r = await call('a', 'GET', `/api/accounts/${A}/messages?folder=INBOX&q=nothingmatches`);
ok(r.json.total === 0, 'search no match');
r = await call('a', 'GET', `/api/accounts/${A}/messages?folder=INBOX&q=Hell`);
ok(r.json.total === 1, 'search subject match');
r = await call('a', 'POST', `/api/accounts/${A}/folders`, { path: 'Projects' });
r = await call('a', 'POST', `/api/accounts/${A}/folders`, { path: 'Trash' });
r = await call('a', 'POST', `/api/accounts/${A}/messages/move`, { folder: 'INBOX', ids: [mid], dest: 'Projects' });
r = await call('a', 'GET', `/api/accounts/${A}/messages?folder=Projects`);
ok(r.json.total === 1, 'moved to Projects');
const pid = r.json.messages[0].id;
r = await call('a', 'POST', `/api/accounts/${A}/messages/delete`, { folder: 'Projects', ids: [pid] });
r = await call('a', 'GET', `/api/accounts/${A}/folders`);
ok(r.json.find((f) => f.path === 'Trash')?.total === 1, 'delete moves to Trash (detected by name)');
r = await call('a', 'POST', `/api/accounts/${A}/folders/empty`, { path: 'Trash' });
r = await call('a', 'GET', `/api/accounts/${A}/folders`);
ok(r.json.find((f) => f.path === 'Trash')?.total === 0, 'empty trash');
r = await call('a', 'POST', `/api/accounts/${A}/folders/empty`, { path: 'Projects' });
ok(r.status === 400, 'cannot empty non-trash folder');

// draft
const dfd = new FormData();
dfd.append('payload', JSON.stringify({ to: 'bob@example.test', bcc: 'carol@example.test', subject: 'draft subj', text: 'wip' }));
r = await call('a', 'POST', `/api/accounts/${A}/drafts`, undefined, { form: dfd });
ok(r.status === 200 && r.json.folder, 'draft saved to ' + JSON.stringify(r.json));
const draftFolder = r.json.folder;
r = await call('a', 'GET', `/api/accounts/${A}/messages?folder=${encodeURIComponent(draftFolder)}`);
ok(r.json.total === 1 && r.json.messages[0].draft, 'draft listed with draft flag');
const did = r.json.messages[0].id;
r = await call('a', 'GET', `/api/accounts/${A}/messages/${did}?folder=${encodeURIComponent(draftFolder)}`);
ok(r.json.bcc?.[0]?.address === 'carol@example.test', 'bcc kept in draft');
const sfd = new FormData();
sfd.append('payload', JSON.stringify({ to: 'bob@example.test', subject: 'draft subj', text: 'final', draftOf: { folder: draftFolder, id: did } }));
r = await call('a', 'POST', `/api/accounts/${A}/send`, undefined, { form: sfd });
r = await call('a', 'GET', `/api/accounts/${A}/messages?folder=${encodeURIComponent(draftFolder)}`);
ok(r.json.total === 0, 'draft removed after sending');

// POP3
await sleep(500);
r = await call('a', 'POST', `/api/accounts/${B}/sync`);
ok(r.json.fetched === 2, 'POP3 fetched 2 messages: ' + JSON.stringify(r.json));
r = await call('a', 'POST', `/api/accounts/${B}/sync`);
ok(r.json.fetched === 0, 'POP3 second sync fetches nothing new');
r = await call('a', 'GET', `/api/accounts/${B}/messages?folder=INBOX`);
ok(r.json.total === 2, 'POP3 inbox has 2');
const bm = r.json.messages.find((m) => m.subject === 'Hellö <test> 1');
r = await call('a', 'GET', `/api/accounts/${B}/messages/${bm.id}?folder=INBOX`);
ok(r.json.text.includes('\n.\n..dots') && r.json.attachments.length === 1, 'POP3 message intact incl. dot-stuffed lines');
r = await call('a', 'POST', `/api/accounts/${B}/messages/delete`, { folder: 'INBOX', ids: [bm.id] });
r = await call('a', 'POST', `/api/accounts/${B}/messages/delete`, { folder: 'Trash', ids: [bm.id] });
r = await call('a', 'POST', `/api/accounts/${B}/sync`);
ok(r.json.fetched === 0, 'deleted POP3 message not re-downloaded (tombstone)');
r = await call('a', 'GET', `/api/accounts/${B}/folders`);
ok(r.json.find((f) => f.path === 'INBOX').total === 1, 'POP3 folder counts');
// reply from bob (pop3) -> stored in local Sent, original marked answered
const other = (await call('a', 'GET', `/api/accounts/${B}/messages?folder=INBOX`)).json.messages[0];
const rfd = new FormData();
rfd.append('payload', JSON.stringify({ to: 'alice@example.test', subject: 'Re: x', text: 'reply', replyOf: { folder: 'INBOX', id: other.id } }));
r = await call('a', 'POST', `/api/accounts/${B}/send`, undefined, { form: rfd });
ok(r.status === 200, 'POP3 account sends via plain SMTP');
r = await call('a', 'GET', `/api/accounts/${B}/messages?folder=INBOX`);
ok(r.json.messages[0].answered, 'replied message marked answered');
r = await call('a', 'GET', `/api/accounts/${B}/folders`);
ok(r.json.find((f) => f.path === 'Sent').total === 1, 'POP3 sent copy stored locally');

// exports
for (const format of ['autoconfig', 'apple', 'json', 'sheet']) {
  res = await call('a', 'POST', '/api/export', { format }, { raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  ok(res.status === 200 && buf.length > 100, `export ${format}: ${res.headers.get('content-disposition')} ${buf.length}b`);
}
r = await call('a', 'POST', '/api/export', { format: 'sheet', includePasswords: true });
ok(r.status === 403, 'passwords require re-auth');
res = await call('a', 'POST', '/api/export', { format: 'json', includePasswords: true, currentPassword: 'correct horse battery' }, { raw: true });
const exported = await res.json();
ok(exported.accounts[0].password === 'alicepass', 'export with passwords after re-auth');

// Thunderbird / K-9 / QR exports and Thunderbird prefs.js round trip
res = await call('a', 'POST', '/api/export', { format: 'thunderbird' }, { raw: true });
const { unzipSync, strFromU8 } = await import('fflate');
const tbFiles = unzipSync(new Uint8Array(await res.arrayBuffer()));
ok(Object.keys(tbFiles).sort().join() === 'README.txt,prefs.js', 'thunderbird zip has prefs.js at root');
const tbPrefs = strFromU8(tbFiles['prefs.js']);
ok(/user_pref\("mail\.server\.server1\.hostname", "127\.0\.0\.1"\);/.test(tbPrefs) && /mail\.identity\.id1\.smtpServer", "smtp1"/.test(tbPrefs), 'prefs.js describes servers and identities');
res = await call('a', 'POST', '/api/export', { format: 'k9' }, { raw: true });
const k9 = await res.text();
ok(k9.includes('<k9settings version="99" format="1">') && k9.includes('<incoming-server type="POP3">') && !k9.includes('<password>'), 'k9s file without passwords');
r = await call('a', 'POST', '/api/export/qr', { format: 'qr' });
ok(r.json.codes?.length === 1 && r.json.codes[0].dataUrl.startsWith('data:image/png;base64,'), 'QR code generated');

// second user and isolation
r = await call('a', 'POST', '/api/admin/users', { username: 'carol', password: 'another long password' });
ok(r.status === 200, 'admin creates user');
r = await call('c', 'POST', '/api/auth/login', { username: 'carol', password: 'another long password' });
ok(r.status === 200, 'carol logs in');
r = await call('c', 'GET', `/api/accounts/${A}/folders`);
ok(r.status === 404, 'carol cannot access alice account');
r = await call('c', 'GET', '/api/admin/users');
ok(r.status === 403, 'non-admin blocked from admin API');
r = await call('c', 'POST', '/api/import/json', exported);
ok(r.json.created?.length === 2, 'carol imports JSON export: ' + JSON.stringify(r.json.skipped));
r = await call('c', 'POST', '/api/import/json', exported);
ok(r.json.created?.length === 0 && r.json.skipped.length === 2, 're-import skips duplicates');
r = await call('c', 'POST', '/api/import/thunderbird', { prefs: tbPrefs });
ok(r.json.created?.length === 0 && r.json.skipped.length === 2, 'thunderbird import recognises existing accounts');
await call('a', 'POST', '/api/admin/users', { username: 'dave', password: 'yet another password' });
await call('d', 'POST', '/api/auth/login', { username: 'dave', password: 'yet another password' });
r = await call('d', 'POST', '/api/import/thunderbird', { prefs: tbPrefs });
ok(r.json.created?.length === 2 && r.json.created[0].displayName === 'Alice Ä' && r.json.created[0].signature.includes('Alice'), 'thunderbird prefs.js import creates accounts');
const carolAcc = (await call('c', 'GET', '/api/accounts')).json.find((a) => a.protocol === 'imap');
r = await call('c', 'GET', `/api/accounts/${carolAcc.id}/messages?folder=INBOX`);
ok(r.status === 200, 'imported account works with imported password');
r = await call('c', 'GET', `/api/accounts/9999/messages?folder=INBOX`);
ok(r.status === 404, 'unknown account 404');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
