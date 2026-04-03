import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = resolve(rootDir, 'server');
const distDir = resolve(serverDir, 'dist');
const publicSrcDir = resolve(serverDir, 'src/web/public');
const stageDir = resolve(rootDir, '.artifacts/release/server');
const serverReadme = resolve(serverDir, 'README.md');
const licensePath = resolve(serverDir, 'LICENSE');
const serverPackage = JSON.parse(readFileSync(resolve(serverDir, 'package.json'), 'utf8'));

rmSync(distDir, { recursive: true, force: true });
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(resolve(distDir, 'public'), { recursive: true });
mkdirSync(stageDir, { recursive: true });

await build({
  entryPoints: [resolve(serverDir, 'src/index.ts')],
  outfile: resolve(distDir, 'index.js'),
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
});

execFileSync('npx', ['tsc', '--project', 'server/tsconfig.types.json'], {
  cwd: rootDir,
  stdio: 'inherit',
});

for (const relativePath of ['index.html', 'style.css', 'app.js', 'logo-mark.svg']) {
  const sourcePath = resolve(publicSrcDir, relativePath);
  const outputPath = resolve(distDir, 'public', relativePath);
  const source = readFileSync(sourcePath, 'utf8');
  const extension = extname(relativePath);

  if (extension === '.js') {
    const result = await transform(source, {
      loader: 'js',
      minify: true,
      target: 'es2022',
      legalComments: 'none',
    });
    writeFileSync(outputPath, result.code);
    continue;
  }

  if (extension === '.css') {
    const result = await transform(source, {
      loader: 'css',
      minify: true,
      legalComments: 'none',
    });
    writeFileSync(outputPath, result.code);
    continue;
  }

  if (extension === '.html') {
    writeFileSync(outputPath, minifyHtml(source));
    continue;
  }

  writeFileSync(outputPath, minifySvg(source));
}

writeFileSync(resolve(distDir, '.build-meta.json'), JSON.stringify({
  builtAt: new Date().toISOString(),
  target: 'node20',
}, null, 2));

cpSync(resolve(distDir, 'index.js'), resolve(stageDir, 'index.js'));
cpSync(resolve(distDir, 'public'), resolve(stageDir, 'public'), { recursive: true });
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

function minifyHtml(source) {
  return source
    .replace(/>\s+</g, '><')
    .replace(/\n+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function minifySvg(source) {
  return source
    .replace(/>\s+</g, '><')
    .replace(/\n+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function exists(path) {
  try {
    readFileSync(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}
