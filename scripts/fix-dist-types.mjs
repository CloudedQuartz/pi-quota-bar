// tsc rewrites .ts import extensions to .js in JS emit but not in declaration
// emit. Consumers without allowImportingTsExtensions cannot typecheck those.
// Rewrite declaration specifiers mechanically and fail the build on leftovers.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../dist/query/', import.meta.url).pathname;
let touched = 0;
for (const file of readdirSync(dir)) {
  if (!file.endsWith('.d.ts')) continue;
  const path = join(dir, file);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(/from '(\.[^']*)\.ts'/g, "from '$1.js'");
  if (after !== before) { writeFileSync(path, after); touched++; }
  if (/from '\.[^']*\.ts'/.test(after)) throw new Error(`unrewritten .ts specifier left in ${file}`);
}
console.log(`fix-dist-types: rewrote ${touched} declaration file(s)`);
