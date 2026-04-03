import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootPackage = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function bumpMinor(version) {
  const parsed = parseVersion(version);
  return `${parsed.major}.${parsed.minor + 1}.0`;
}

let latestTag = '';

try {
  latestTag = execFileSync('git', ['tag', '--list', 'v*', '--sort=-version:refname'], {
    cwd: rootDir,
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean)[0] ?? '';
} catch {
  latestTag = '';
}

const baseVersion = latestTag ? latestTag.replace(/^v/, '') : rootPackage.version;
process.stdout.write(`${bumpMinor(baseVersion)}\n`);
