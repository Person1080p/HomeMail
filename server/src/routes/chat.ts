import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { parse } from '../http.js';
import { openStream } from '../events.js';
import { chatDomain, federationEnabled, userAddress } from '../server-settings.js';
import * as chat from '../chat/service.js';

export const chatRouter = Router();

chatRouter.get('/events', requireUser, (req, res) => openStream(req, res));

chatRouter.get('/chat/info', requireUser, (req, res) => {
  res.json({ address: userAddress(req.user!.username), domain: chatDomain(), federation: federationEnabled() });
});

chatRouter.get('/chat/directory', requireUser, (req, res) => {
  res.json(chat.directory(req.user!.id));
});

chatRouter.get('/chat/conversations', requireUser, (req, res) => {
  res.json(chat.listConversations(req.user!.id));
});

chatRouter.get('/chat/conversations/:id', requireUser, (req, res) => {
  res.json(chat.getConversation(req.user!.id, Number(req.params.id)));
});

/** Opens (or finds) a direct conversation with an address like bob@home.mail. */
chatRouter.post('/chat/dm', requireUser, (req, res) => {
  const body = parse(z.object({ address: z.string().trim().min(1).max(320) }), req.body);
  const id = chat.openDm(req.user!.id, chat.resolveAddress(body.address));
  res.json(chat.conversationView(req.user!.id, id));
});

const memberIds = z.array(z.number().int().positive()).max(500);

chatRouter.post('/chat/groups', requireUser, (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(100), members: memberIds }), req.body);
  const id = chat.createGroup(req.user!.id, body.name, body.members);
  res.json(chat.conversationView(req.user!.id, id));
});

chatRouter.patch('/chat/conversations/:id', requireUser, (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
  chat.renameGroup(req.user!.id, Number(req.params.id), body.name);
  res.json({ ok: true });
});

chatRouter.post('/chat/conversations/:id/members', requireUser, (req, res) => {
  const body = parse(z.object({ members: memberIds.min(1) }), req.body);
  chat.addMembers(req.user!.id, Number(req.params.id), body.members);
  res.json({ ok: true });
});

chatRouter.delete('/chat/conversations/:id/members/:userId', requireUser, (req, res) => {
  chat.removeMember(req.user!.id, Number(req.params.id), Number(req.params.userId));
  res.json({ ok: true });
});

chatRouter.delete('/chat/conversations/:id', requireUser, (req, res) => {
  chat.deleteDm(req.user!.id, Number(req.params.id));
  res.json({ ok: true });
});

chatRouter.get('/chat/conversations/:id/messages', requireUser, (req, res) => {
  const q = parse(z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  res.json(chat.listMessages(req.user!.id, Number(req.params.id), q.before, q.limit));
});

chatRouter.post('/chat/conversations/:id/messages', requireUser, (req, res) => {
  const body = parse(z.object({ body: z.string().trim().min(1).max(10_000) }), req.body);
  res.json(chat.sendMessage(req.user!.id, Number(req.params.id), body.body));
});

chatRouter.delete('/chat/messages/:id', requireUser, (req, res) => {
  chat.deleteMessage(req.user!.id, Number(req.params.id));
  res.json({ ok: true });
});

chatRouter.post('/chat/conversations/:id/read', requireUser, (req, res) => {
  const body = parse(z.object({ messageId: z.number().int().positive() }), req.body);
  chat.markRead(req.user!.id, Number(req.params.id), body.messageId);
  res.json({ ok: true });
});

chatRouter.post('/chat/conversations/:id/typing', requireUser, (req, res) => {
  const body = parse(z.object({ active: z.boolean() }), req.body);
  chat.typing(req.user!.id, Number(req.params.id), body.active);
  res.json({ ok: true });
});
