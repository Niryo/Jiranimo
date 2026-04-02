import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const sourceUrl = import.meta.resolve('@jiranimo/assets/logo-mark.svg');
const sourcePath = fileURLToPath(sourceUrl);
const extensionRoot = resolve(import.meta.dirname, '..');
const svg = await readFile(sourcePath);

const outputs = [
  { size: 16, path: resolve(extensionRoot, 'icons/icon-16.png') },
  { size: 32, path: resolve(extensionRoot, 'icons/icon-32.png') },
  { size: 48, path: resolve(extensionRoot, 'icons/icon-48.png') },
  { size: 128, path: resolve(extensionRoot, 'icons/icon-128.png') },
];

for (const output of outputs) {
  await mkdir(dirname(output.path), { recursive: true });
  const rendered = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: output.size,
    },
  }).render();
  await writeFile(output.path, rendered.asPng());
}

console.log('Built extension icons from shared assets package.');
