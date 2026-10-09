import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);

/** Parses a request body/query with a zod schema, turning failures into 400s. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(`${issue.path.join('.') || 'input'}: ${issue.message}`);
  }
  return result.data;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  const e = err as { message?: string; code?: string; status?: number; type?: string };
  if (e?.type === 'entity.too.large' || e?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'Upload too large' });
    return;
  }
  console.error('[error]', err);
  // Mail server errors are usually actionable for the user (bad password, host unreachable, ...)
  res.status(502).json({ error: describeMailError(err) });
}

/** Turns IMAP/SMTP/network errors into something a person can act on. */
export function describeMailError(err: unknown): string {
  const e = err as {
    message?: string;
    code?: string;
    responseText?: string;
    response?: string;
    authenticationFailed?: boolean;
  };
  if (!e) return 'Unknown error';
  if (e.authenticationFailed || e.code === 'EAUTH' || /auth/i.test(e.code || '')) {
    return `Authentication failed${e.responseText || e.response ? `: ${e.responseText || e.response}` : ''}. Check the username and password (many providers need an app password).`;
  }
  switch (e.code) {
    case 'ENOTFOUND':
      return 'Server hostname not found (DNS lookup failed).';
    case 'ECONNREFUSED':
      return 'Connection refused. Check the host and port.';
    case 'ETIMEDOUT':
    case 'ETIMEOUT':
    case 'CONNECT_TIMEOUT':
      return 'Connection timed out.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'The server uses a self-signed certificate. Enable "Allow self-signed certificates" for this account if you trust it (e.g. Proton Mail Bridge).';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'The server certificate does not match the hostname.';
  }
  return e.responseText || e.message || String(err);
}
