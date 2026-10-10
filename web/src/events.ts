/**
 * One Server-Sent Events stream per browser tab (/api/events), fanned out to
 * listeners by event name. EventSource reconnects on its own.
 */
type Listener = (data: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

const listeners = new Map<string, Set<Listener>>();
let source: EventSource | null = null;
const KNOWN = ['chat.message', 'chat.conversation', 'chat.removed', 'chat.read', 'chat.typing', 'presence', 'mail.new'];

export function connectEvents() {
  if (source) return;
  source = new EventSource('/api/events');
  for (const name of KNOWN) source.addEventListener(name, (e) => emit(name, JSON.parse((e as MessageEvent).data)));
  source.addEventListener('open', () => emit('connected', null));
}

export function disconnectEvents() {
  source?.close();
  source = null;
}

function emit(name: string, data: unknown) {
  for (const fn of listeners.get(name) ?? []) fn(data);
}

/** Subscribes and returns the unsubscribe function (handy as a useEffect cleanup). */
export function onEvent(name: string, fn: Listener): () => void {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(fn);
  return () => listeners.get(name)!.delete(fn);
}
