import { Router, type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { badRequest, notFound, parse } from '../http.js';
import { type AccountRow, getAccount, setAccountStatus } from '../accounts.js';
import { backendFor } from '../mail/service.js';
import { attachmentName, parseRaw, renderMessage } from '../mail/parse.js';
import { type ComposeInput, saveDraft, sendMessage } from '../mail/smtp.js';
import { FOLDER_ORDER } from '../mail/types.js';
import { syncPop3 } from '../mail/local.js';
import { type UnsubscribeMethod, parseMailto, recordUnsubscribe, unsubscribeOneClick, unsubscribedAt } from '../mail/unsubscribe.js';

export const mailRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 50 },
});

const account = (req: Request): AccountRow => getAccount(req.user!.id, Number(req.params.accountId));
const folderParam = z.string().min(1).max(1000);
const ids = z.array(z.number().int().positive()).min(1).max(5000);

mailRouter.get('/accounts/:accountId/folders', requireUser, async (req, res) => {
  const acc = account(req);
  const folders = await backendFor(acc).listFolders();
  setAccountStatus(acc.id, null);
  const rank = (f: (typeof folders)[number]) => {
    const i = FOLDER_ORDER.indexOf(f.specialUse);
    return i < 0 ? FOLDER_ORDER.length : i;
  };
  folders.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  res.json(folders);
});

mailRouter.post('/accounts/:accountId/folders', requireUser, async (req, res) => {
  const body = parse(z.object({ path: folderParam }), req.body);
  await backendFor(account(req)).createFolder(body.path);
  res.json({ ok: true });
});

mailRouter.patch('/accounts/:accountId/folders', requireUser, async (req, res) => {
  const body = parse(z.object({ path: folderParam, newPath: folderParam }), req.body);
  await backendFor(account(req)).renameFolder(body.path, body.newPath);
  res.json({ ok: true });
});

mailRouter.delete('/accounts/:accountId/folders', requireUser, async (req, res) => {
  const q = parse(z.object({ path: folderParam }), req.query);
  if (q.path.toUpperCase() === 'INBOX') throw badRequest('The Inbox cannot be deleted');
  await backendFor(account(req)).deleteFolder(q.path);
  res.json({ ok: true });
});

mailRouter.post('/accounts/:accountId/folders/empty', requireUser, async (req, res) => {
  const body = parse(z.object({ path: folderParam }), req.body);
  const backend = backendFor(account(req));
  const allowed = [await backend.specialFolder('\\Trash'), await backend.specialFolder('\\Junk')];
  if (!allowed.includes(body.path)) throw badRequest('Only Trash and Junk folders can be emptied');
  await backend.emptyFolder(body.path);
  res.json({ ok: true });
});

mailRouter.post('/accounts/:accountId/sync', requireUser, async (req, res) => {
  const acc = account(req);
  if (acc.protocol !== 'pop3') return res.json({ fetched: 0 });
  res.json(await syncPop3(acc.id));
});

mailRouter.get('/accounts/:accountId/messages', requireUser, async (req, res) => {
  const q = parse(
    z.object({
      folder: folderParam,
      page: z.coerce.number().int().min(0).default(0),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
      q: z.string().trim().max(200).optional(),
      unread: z.enum(['0', '1']).optional(),
      flagged: z.enum(['0', '1']).optional(),
    }),
    req.query,
  );
  const acc = account(req);
  // POP3: opportunistically fetch new mail when the inbox is viewed.
  if (acc.protocol === 'pop3' && q.folder === 'INBOX' && Date.now() - (acc.last_sync ?? 0) > 120_000) {
    syncPop3(acc.id).catch(() => {});
  }
  res.json(
    await backendFor(acc).listMessages(q.folder, {
      page: q.page,
      pageSize: q.pageSize,
      query: q.q || undefined,
      unreadOnly: q.unread === '1',
      flaggedOnly: q.flagged === '1',
    }),
  );
});

const msgQuery = z.object({ folder: folderParam, peek: z.enum(['0', '1']).optional() });

mailRouter.get('/accounts/:accountId/messages/:id', requireUser, async (req, res) => {
  const q = parse(msgQuery, req.query);
  const id = Number(req.params.id);
  const backend = backendFor(account(req));
  const raw = await backend.getSource(q.folder, id);
  const msg = await renderMessage(raw);
  if (q.peek !== '1') await backend.setFlags(q.folder, [id], { seen: true });
  const unsubscribed = msg.unsubscribe ? unsubscribedAt(req.user!.id, msg.unsubscribe.listKey) : null;
  res.json({ id, folder: q.folder, size: raw.length, ...msg, unsubscribedAt: unsubscribed });
});

/**
 * Unsubscribes from the mailing list a message came from: a one-click request or an
 * unsubscribe email when the sender supports one. Web-only lists are opened by the
 * browser, which then calls this with method "web" so the choice is remembered.
 */
mailRouter.post('/accounts/:accountId/messages/:id/unsubscribe', requireUser, async (req, res) => {
  const body = parse(z.object({ folder: folderParam, method: z.enum(['auto', 'web']).default('auto'), trash: z.boolean().default(false) }), req.body);
  const id = Number(req.params.id);
  const acc = account(req);
  const backend = backendFor(acc);
  const info = (await renderMessage(await backend.getSource(body.folder, id))).unsubscribe;
  if (!info) throw badRequest('This message has no unsubscribe option');

  let method: UnsubscribeMethod;
  if (body.method === 'web') {
    if (!info.web) throw badRequest('This message has no unsubscribe page');
    method = 'web';
  } else if (info.oneClick) {
    await unsubscribeOneClick(info);
    method = 'one-click';
  } else if (info.mailto) {
    const m = parseMailto(info.mailto);
    await sendMessage(acc, { to: m.to, subject: m.subject, text: m.body, attachments: [] });
    method = 'mailto';
  } else {
    // Only a web page: the browser has to open it.
    return res.json({ method: 'web', url: info.web, done: false });
  }
  recordUnsubscribe(req.user!.id, info, method);
  if (body.trash) await backend.remove(body.folder, [id]);
  res.json({ method, done: true, listName: info.listName, at: Date.now() });
});

mailRouter.get('/accounts/:accountId/messages/:id/raw', requireUser, async (req, res) => {
  const q = parse(msgQuery, req.query);
  const raw = await backendFor(account(req)).getSource(q.folder, Number(req.params.id));
  const parsed = await parseRaw(raw);
  const name = (parsed.subject || 'message').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 100);
  res.attachment(`${name}.eml`).type('message/rfc822').send(raw);
});

mailRouter.get('/accounts/:accountId/messages/:id/attachments/:index', requireUser, async (req, res) => {
  const q = parse(z.object({ folder: folderParam, inline: z.enum(['0', '1']).optional() }), req.query);
  const raw = await backendFor(account(req)).getSource(q.folder, Number(req.params.id));
  const parsed = await parseRaw(raw);
  const index = Number(req.params.index);
  const att = parsed.attachments[index];
  if (!att) throw notFound('Attachment not found');
  // Only plain raster images and PDFs may be shown inline; everything else downloads.
  const inlineSafe = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf)$/i.test(att.contentType);
  const filename = attachmentName(att, index);
  if (q.inline === '1' && inlineSafe) {
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  } else {
    res.attachment(filename);
  }
  res.type(inlineSafe ? att.contentType : 'application/octet-stream').send(att.content);
});

mailRouter.post('/accounts/:accountId/messages/flags', requireUser, async (req, res) => {
  const body = parse(
    z.object({ folder: folderParam, ids, seen: z.boolean().optional(), flagged: z.boolean().optional() }),
    req.body,
  );
  await backendFor(account(req)).setFlags(body.folder, body.ids, { seen: body.seen, flagged: body.flagged });
  res.json({ ok: true });
});

mailRouter.post('/accounts/:accountId/messages/move', requireUser, async (req, res) => {
  const body = parse(z.object({ folder: folderParam, ids, dest: folderParam }), req.body);
  await backendFor(account(req)).move(body.folder, body.ids, body.dest);
  res.json({ ok: true });
});

mailRouter.post('/accounts/:accountId/messages/delete', requireUser, async (req, res) => {
  const body = parse(z.object({ folder: folderParam, ids, permanent: z.boolean().optional() }), req.body);
  await backendFor(account(req)).remove(body.folder, body.ids, body.permanent);
  res.json({ ok: true });
});

const ref = z.object({ folder: folderParam, id: z.number().int().positive() });
const composeSchema = z.object({
  to: z.string().max(20000).default(''),
  cc: z.string().max(20000).optional(),
  bcc: z.string().max(20000).optional(),
  subject: z.string().max(2000).default(''),
  text: z.string().max(5_000_000).default(''),
  html: z.string().max(10_000_000).optional(),
  priority: z.enum(['high', 'normal', 'low']).optional(),
  readReceipt: z.boolean().optional(),
  inReplyTo: z.string().max(2000).optional(),
  references: z.array(z.string().max(2000)).max(200).optional(),
  forwardOf: ref.extend({ attachments: z.array(z.number().int().min(0)).max(500).optional() }).optional(),
  draftOf: ref.optional(),
  replyOf: ref.optional(),
});

/** Compose requests are multipart: a JSON "payload" field plus optional files. */
function composeInput(req: Request): ComposeInput {
  let payload: unknown;
  try {
    payload = JSON.parse(String(req.body?.payload ?? '{}'));
  } catch {
    throw badRequest('Invalid payload');
  }
  const body = parse(composeSchema, payload);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > config.maxUploadMb * 1024 * 1024) throw badRequest(`Attachments exceed ${config.maxUploadMb} MB`);
  return {
    ...body,
    attachments: files.map((f) => ({
      filename: f.originalname,
      contentType: f.mimetype || 'application/octet-stream',
      content: f.buffer,
    })),
  };
}

mailRouter.post('/accounts/:accountId/send', requireUser, upload.array('files'), async (req, res) => {
  await sendMessage(account(req), composeInput(req));
  res.json({ ok: true });
});

mailRouter.post('/accounts/:accountId/drafts', requireUser, upload.array('files'), async (req, res) => {
  res.json(await saveDraft(account(req), composeInput(req)));
});
