export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (body?.error) message = body.error;
  } catch {
    /* not JSON */
  }
  if (res.status === 401) window.dispatchEvent(new Event('homemail:unauthorized'));
  throw new ApiError(res.status, message);
}

/** JSON API call. Every request carries the CSRF header the server requires. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'x-homemail': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handle<T>(res);
}

export async function apiForm<T = unknown>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-homemail': '1' }, body: form });
  return handle<T>(res);
}

/** POSTs and saves the response as a file. Returns the server's list of skipped accounts. */
export async function apiDownload(path: string, body: unknown): Promise<{ label: string; reason: string }[]> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-homemail': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await handle(res);
  const disposition = res.headers.get('content-disposition') || '';
  const name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? 'download';
  saveBlob(await res.blob(), decodeURIComponent(name));
  const skipped = res.headers.get('x-homemail-skipped');
  return skipped ? JSON.parse(decodeURIComponent(skipped)) : [];
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const mailPath = (accountId: number, rest: string) => `/accounts/${accountId}${rest}`;
export const qs = (params: Record<string, string | number | undefined | null | false>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== false && v !== '') p.set(k, String(v));
  return p.toString();
};
