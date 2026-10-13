import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

/** Newest modification time of the files in a directory tree (0 if it doesn't exist). */
function newest(dir: string): number {
  let latest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    latest = Math.max(latest, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return latest;
}

/**
 * When running the compiled server (server/dist) from a source checkout, warns if the
 * sources or the web app changed after the last build: the running app would be out of date.
 * Docker images contain no sources, so this stays silent there.
 */
export function warnIfStaleBuild(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (path.basename(here) !== 'dist') return;
  const built = fs.statSync(path.join(here, 'index.js')).mtimeMs;
  const stale = [
    ['server/src', newest(path.join(here, '../src'))],
    ['web/src', newest(path.join(here, '../../web/src'))],
  ].filter(([, t]) => (t as number) > built);
  const webBuilt = newest(config.webDir);
  const webSrc = newest(path.join(here, '../../web/src'));
  if (!stale.length && !(webBuilt && webSrc > webBuilt)) return;
  console.warn(
    `[build] This is an old build: ${stale.map(([d]) => d).join(' and ') || 'web/src'} changed since it was compiled. ` +
      'Run "npm run build" (or use "npm run dev") so the app matches the code.',
  );
}
