import net from 'node:net';
import tls from 'node:tls';
import type { Security } from '../providers.js';

export class Pop3Error extends Error {
  code = 'EPOP3';
  constructor(
    message: string,
    public authenticationFailed = false,
  ) {
    super(message);
  }
}

export interface Pop3Options {
  host: string;
  port: number;
  security: Security;
  rejectUnauthorized: boolean;
  timeoutMs?: number;
}

const TERMINATOR = Buffer.from('\r\n.\r\n');

/** SNI must be a hostname, never an IP address. */
const sni = (host: string) => (net.isIP(host) ? undefined : host);

/**
 * Minimal POP3 client (RFC 1939 + STLS, RFC 2595, and XOAUTH2).
 * Commands are strictly sequential: await each call before the next.
 */
export class Pop3Client {
  private socket!: net.Socket;
  private chunks: Buffer[] = [];
  private wake?: () => void;
  private failure: Error | null = null;
  private closed = false;

  private constructor(private opts: Pop3Options) {}

  static async connect(opts: Pop3Options): Promise<Pop3Client> {
    const c = new Pop3Client(opts);
    const sock =
      opts.security === 'tls'
        ? tls.connect({ host: opts.host, port: opts.port, servername: sni(opts.host), rejectUnauthorized: opts.rejectUnauthorized })
        : net.connect({ host: opts.host, port: opts.port });
    await new Promise<void>((resolve, reject) => {
      sock.once(opts.security === 'tls' ? 'secureConnect' : 'connect', () => resolve());
      sock.once('error', reject);
      sock.setTimeout(opts.timeoutMs ?? 20_000, () => sock.destroy(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })));
    });
    c.attach(sock);
    await c.expectOk(await c.readLine());
    if (opts.security === 'starttls') await c.startTls();
    return c;
  }

  private attach(sock: net.Socket) {
    this.socket = sock;
    sock.removeAllListeners('error');
    sock.on('data', (d: Buffer) => {
      this.chunks.push(d);
      this.notify();
    });
    sock.on('error', (err) => {
      this.failure = err;
      this.notify();
    });
    sock.on('close', () => {
      this.closed = true;
      this.notify();
    });
    sock.setTimeout(this.opts.timeoutMs ?? 60_000, () => sock.destroy(Object.assign(new Error('POP3 server stopped responding'), { code: 'ETIMEDOUT' })));
  }

  private notify() {
    const w = this.wake;
    this.wake = undefined;
    w?.();
  }

  private async waitForData(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Pop3Error('Connection closed by POP3 server');
    await new Promise<void>((r) => (this.wake = r));
    if (this.failure) throw this.failure;
  }

  private async readLine(): Promise<string> {
    for (;;) {
      if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
      const buf = this.chunks[0];
      const i = buf ? buf.indexOf('\r\n') : -1;
      if (i >= 0) {
        const rest = buf.subarray(i + 2);
        this.chunks = rest.length ? [rest] : [];
        return buf.subarray(0, i).toString('utf8');
      }
      await this.waitForData();
    }
  }

  /**
   * Reads a dot-terminated multi-line body. Scans each chunk only once (plus a
   * 4-byte overlap) so large messages are not repeatedly concatenated.
   */
  private async readMultiline(): Promise<Buffer> {
    const parts: Buffer[] = [];
    let received = 0;
    let tail = Buffer.from('\r\n'); // virtual CRLF so an empty body (".\r\n") matches too
    for (;;) {
      while (this.chunks.length) {
        const chunk = this.chunks.shift()!;
        const probe = Buffer.concat([tail, chunk]);
        const idx = probe.indexOf(TERMINATOR);
        if (idx >= 0) {
          // Position of the terminator in the body stream (which excludes the virtual CRLF).
          const end = received - (tail.length - 2) + idx - 2 + 2;
          const all = Buffer.concat([...parts, chunk]);
          const body = all.subarray(0, Math.max(0, end));
          const rest = all.subarray(end + 3);
          if (rest.length) this.chunks.unshift(rest);
          return unstuff(body);
        }
        parts.push(chunk);
        received += chunk.length;
        tail = probe.subarray(Math.max(0, probe.length - 4));
      }
      await this.waitForData();
    }
  }

  private expectOk(line: string, hideArg = false): string {
    if (line.startsWith('+OK')) return line;
    const msg = line.replace(/^-ERR\s*/, '');
    const auth = hideArg || /auth|login|password|credential/i.test(msg);
    throw new Pop3Error(`POP3 server said: ${msg || line}`, auth);
  }

  private async command(line: string, multiline = false, sensitive = false): Promise<{ status: string; body?: Buffer }> {
    this.socket.write(line + '\r\n');
    const status = this.expectOk(await this.readLine(), sensitive);
    return multiline ? { status, body: await this.readMultiline() } : { status };
  }

  private async startTls() {
    await this.command('STLS');
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('close');
    plain.setTimeout(0);
    const secure = tls.connect({ socket: plain, servername: sni(this.opts.host), rejectUnauthorized: this.opts.rejectUnauthorized });
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', () => resolve());
      secure.once('error', reject);
    });
    this.chunks = [];
    this.attach(secure);
  }

  async login(user: string, pass: string) {
    await this.command(`USER ${user}`);
    await this.command(`PASS ${pass}`, false, true);
  }

  async loginOAuth(user: string, accessToken: string) {
    const token = Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`).toString('base64');
    this.socket.write(`AUTH XOAUTH2 ${token}\r\n`);
    let line = await this.readLine();
    if (line.startsWith('+ ') || line === '+') {
      // Server sent an error challenge; reply empty to receive the final -ERR.
      this.socket.write('\r\n');
      line = await this.readLine();
    }
    this.expectOk(line, true);
  }

  /** Returns message numbers with their unique ids. */
  async uidl(): Promise<{ n: number; uid: string }[]> {
    const { body } = await this.command('UIDL', true);
    return body!
      .toString('latin1')
      .split('\r\n')
      .filter(Boolean)
      .map((l) => {
        const [n, uid] = l.trim().split(/\s+/);
        return { n: Number(n), uid };
      });
  }

  async retr(n: number): Promise<Buffer> {
    return (await this.command(`RETR ${n}`, true)).body!;
  }

  async dele(n: number): Promise<void> {
    await this.command(`DELE ${n}`);
  }

  async quit(): Promise<void> {
    try {
      await this.command('QUIT');
    } finally {
      this.socket.end();
    }
  }

  destroy() {
    this.socket?.destroy();
  }
}

/** Reverses POP3 dot-stuffing: a line starting with ".." becomes ".". */
function unstuff(body: Buffer): Buffer {
  if (body.indexOf('\r\n..') < 0 && !(body[0] === 0x2e && body[1] === 0x2e)) return body;
  return Buffer.from(body.toString('latin1').replace(/(^|\r\n)\.\./g, '$1.'), 'latin1');
}
