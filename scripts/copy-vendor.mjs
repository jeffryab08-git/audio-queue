/**
 * Copies the compiled ESM output into the demo app so www/ can import it with a
 * plain <script type="module"> - no bundler in the example on purpose, to prove
 * the module has no build-time magic.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const from = resolve(root, 'dist/esm');
const to = resolve(root, 'example/www/vendor');

await rm(to, { recursive: true, force: true });
await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log(`copied ${from} -> ${to}`);
