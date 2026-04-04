import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..', '..');
const sourcePath = resolve(root, 'packages/assets/src/logo-mark.svg');
const serverLogoPath = resolve(root, 'packages/server/src/web/public/logo-mark.svg');

const svg = await readFile(sourcePath);

await mkdir(dirname(serverLogoPath), { recursive: true });
await writeFile(serverLogoPath, svg);
console.log('Synced shared server logo asset.');
