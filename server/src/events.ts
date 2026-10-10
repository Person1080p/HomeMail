import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

/**
 * Per-user Server-Sent Events. A user is "online" while at least one browser tab
 * holds an open event stream.
 */

const streams = new Map<number, Set<Response>>();

/** Emits "presence" with (userId, online) when a user's online state changes. */
export const presence = new EventEmitter();

export function isOnline(userId: number): boolean {
  return (streams.get(userId)?.size ?? 0) > 0;
}

export function onlineUserIds(): number[] {
  return [...streams.keys()];
}

export function publish(userIds: number | Iterable<number>, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of typeof userIds === 'number' ? [userIds] : userIds) {
    for (const res of streams.get(id) ?? []) res.write(payload);
  }
}

export function openStream(req: Request, res: Response): void {
  const userId = req.user!.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Stop nginx and similar proxies from buffering the stream.
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let set = streams.get(userId);
  const wasOnline = !!set?.size;
  if (!set) streams.set(userId, (set = new Set()));
  set.add(res);
  if (!wasOnline) presence.emit('presence', userId, true);

  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    set!.delete(res);
    if (set!.size === 0) {
      streams.delete(userId);
      presence.emit('presence', userId, false);
    }
  });
}
