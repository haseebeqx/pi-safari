import { readFileSync } from 'node:fs';

function loadVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch { return 'unknown'; }
}
export const VERSION = loadVersion();
