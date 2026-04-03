import { mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = resolve(rootDir, 'extension');
const stageDir = resolve(rootDir, '.artifacts/release/extension');

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const filesToMinify = [
  'background.js',
  'content/board-config.js',
  'content/content.js',
  'lib/adf-to-markdown.js',
  'lib/jira-api.js',
  'options/options.js',
  'content/content.css',
  'options/options.html',
];

for (const relativePath of filesToMinify) {
  const sourcePath = resolve(extensionDir, relativePath);
  const outputPath = resolve(stageDir, relativePath);
  const extension = extname(relativePath);
  const original = readFileSync(sourcePath, 'utf8');

  mkdirSync(dirname(outputPath), { recursive: true });

  if (extension === '.js') {
    const source = relativePath === 'background.js' ? stripAutoReload(original) : original;
    const result = await transform(source, {
      loader: 'js',
      minify: true,
      target: 'chrome120',
      legalComments: 'none',
    });
    writeFileSync(outputPath, result.code);
    continue;
  }

  if (extension === '.css') {
    const result = await transform(original, {
      loader: 'css',
      minify: true,
      legalComments: 'none',
    });
    writeFileSync(outputPath, result.code);
    continue;
  }

  writeFileSync(outputPath, minifyHtml(original));
}

const manifest = JSON.parse(readFileSync(resolve(extensionDir, 'manifest.json'), 'utf8'));
writeFileSync(resolve(stageDir, 'manifest.json'), JSON.stringify(manifest));

cpSync(resolve(extensionDir, 'icons'), resolve(stageDir, 'icons'), { recursive: true });

function stripAutoReload(source) {
  return source.replace(
    /\/\/ --- Optional local auto-reload ---[\s\S]*?(?=\/\/ Proxy Jiranimo server API calls from content scripts\.)/,
    '',
  );
}

function minifyHtml(source) {
  return source
    .replace(/>\s+</g, '><')
    .replace(/\n+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
