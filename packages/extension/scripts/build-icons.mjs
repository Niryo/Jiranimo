import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(import.meta.dirname, '..');
const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  const sourcePath = fileURLToPath(import.meta.resolve(`@jiranimo/assets/icons/icon-${size}.png`));
  const outputPath = resolve(extensionRoot, `icons/icon-${size}.png`);
  await mkdir(dirname(outputPath), { recursive: true });
  await cp(sourcePath, outputPath);
}

console.log('Copied extension icons from shared assets package.');
