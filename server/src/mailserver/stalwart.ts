import { config } from '../config.js';
import { HttpError } from '../http.js';
import { mailDomain, mailHostname } from '../server-settings.js';

/*
 * Talks to a bundled Stalwart mail server (v0.16) through its JMAP management API,
 * authenticating as the recovery administrator (STALWART_RECOVERY_ADMIN on the
 * Stalwart side, STALWART_ADMIN here). Stalwart starts from a pre-written
 * config.json, so it never enters its interactive bootstrap mode.
 */

type Call = [string, Record<string, unknown>, string];

async function jmap(calls: Call[]): Promise<[string, Record<string, unknown>, string][]> {
  const sw = config.stalwart;
  if (!sw) throw new HttpError(503, 'Stalwart is not configured (STALWART_URL)');
  let res: Response;
  try {
    res = await fetch(`${sw.url}/jmap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(sw.admin).toString('base64')}` },
      body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: calls }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new HttpError(503, `Cannot reach Stalwart at ${sw.url}: ${(err as Error).message}`);
  }
  if (res.status === 401) throw new HttpError(503, 'Stalwart rejected the admin login; STALWART_ADMIN must match STALWART_RECOVERY_ADMIN');
  if (!res.ok) throw new HttpError(503, `Stalwart API error ${res.status}`);
  const body = (await res.json()) as { methodResponses: [string, Record<string, unknown>, string][] };
  for (const [name, args] of body.methodResponses) {
    if (name === 'error') throw new HttpError(503, `Stalwart: ${String(args.description ?? args.type)}`);
  }
  return body.methodResponses;
}

/** Runs one /set call and turns per-object failures into errors. */
async function set(object: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const [[, res]] = await jmap([[`x:${object}/set`, args, 's']]);
  for (const key of ['notCreated', 'notUpdated', 'notDestroyed']) {
    const failed = res[key] as Record<string, { description?: string; type?: string }> | undefined;
    if (failed && Object.keys(failed).length) {
      const f = Object.values(failed)[0];
      throw new HttpError(400, `Stalwart refused the change: ${f.description ?? f.type}`);
    }
  }
  return res;
}

async function queryIds(object: string, filter: Record<string, unknown>): Promise<string[]> {
  const [[, res]] = await jmap([[`x:${object}/query`, { filter }, 'q']]);
  return (res.ids as string[]) ?? [];
}

let domainCache: { name: string; id: string } | null = null;

/** Creates the mail domain in Stalwart if needed and points the server's hostname at it. */
export async function ensureStalwartDomain(): Promise<string> {
  const name = mailDomain();
  if (domainCache?.name === name) return domainCache.id;
  let [id] = await queryIds('Domain', { name });
  if (!id) {
    const res = await set('Domain', { create: { d: { name } } }).catch((err) => {
      throw new HttpError(400, `${err.message}. Stalwart only accepts domains under a real top-level domain (e.g. home.internal or your own domain).`);
    });
    id = (res.created as Record<string, { id: string }>).d.id;
  }
  await set('SystemSettings', { update: { singleton: { defaultHostname: mailHostname(), defaultDomainId: id } } });
  await set('Action', { create: { r: { '@type': 'ReloadSettings' } } });
  domainCache = { name, id };
  return id;
}

/** Creates the user's Stalwart account, or resets its password if it exists. */
export async function upsertStalwartUser(username: string, password: string, displayName: string): Promise<void> {
  const domainId = await ensureStalwartDomain();
  const credentials = { '0': { '@type': 'Password', secret: password } };
  const [existing] = await queryIds('Account', { name: username });
  if (existing) {
    await set('Account', { update: { [existing]: { credentials, description: displayName, domainId } } });
  } else {
    await set('Account', { create: { u: { '@type': 'User', name: username, domainId, credentials, description: displayName } } });
  }
}

export async function deleteStalwartUser(username: string): Promise<void> {
  const [existing] = await queryIds('Account', { name: username });
  if (existing) await set('Account', { destroy: [existing] });
}

export async function stalwartStatus(): Promise<{ ok: boolean; error: string | null; dnsZone: string | null }> {
  if (!config.stalwart) return { ok: false, error: 'Not configured', dnsZone: null };
  try {
    const id = await ensureStalwartDomain();
    const [[, res]] = await jmap([['x:Domain/get', { ids: [id], properties: ['dnsZoneFile'] }, 'g']]);
    const list = res.list as { dnsZoneFile?: string }[];
    return { ok: true, error: null, dnsZone: list[0]?.dnsZoneFile ?? null };
  } catch (err) {
    domainCache = null;
    return { ok: false, error: (err as Error).message, dnsZone: null };
  }
}
