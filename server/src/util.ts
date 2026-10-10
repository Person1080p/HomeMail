/** Rejects if `p` hasn't settled within `ms`, e.g. an SMTP peer that drops the connection before its greeting. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out`), { code: 'ETIMEDOUT' })), ms);
    }),
  ]);
}
