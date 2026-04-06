import { mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = resolve(rootDir, 'packages/server');
const distDir = resolve(serverDir, 'dist');
const stageDir = resolve(rootDir, '.artifacts/release/server');
const serverReadme = resolve(serverDir, 'README.md');
const licensePath = resolve(serverDir, 'LICENSE');
const serverPackage = JSON.parse(readFileSync(resolve(serverDir, 'package.json'), 'utf8'));

rmSync(distDir, { recursive: true, force: true });
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
mkdirSync(stageDir, { recursive: true });

await build({
  entryPoints: [resolve(serverDir, 'src/index.ts')],
  outfile: resolve(distDir, 'index.js'),
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
});

writeFileSync(resolve(distDir, '.build-meta.json'), JSON.stringify({
  builtAt: new Date().toISOString(),
  target: 'node24',
}, null, 2));

cpSync(resolve(distDir, 'index.js'), resolve(stageDir, 'index.js'));
writeFileSync(resolve(stageDir, 'package.json'), `${JSON.stringify({
  name: serverPackage.name,
  version: serverPackage.version,
  type: 'module',
  private: true,
}, null, 2)}\n`);

if (exists(serverReadme)) {
  cpSync(serverReadme, resolve(stageDir, 'README.md'));
}

if (exists(licensePath)) {
  cpSync(licensePath, resolve(stageDir, 'LICENSE'));
}

function exists(path) {
  try {
    readFileSync(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}
