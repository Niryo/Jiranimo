import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nextVersion = process.argv[2]?.trim();

if (!nextVersion || !/^\d+\.\d+\.\d+$/.test(nextVersion)) {
  throw new Error('Usage: node scripts/set-version.mjs <x.y.z>');
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(rootDir, relativePath), 'utf8'));
}

function writeJson(relativePath, value) {
  writeFileSync(resolve(rootDir, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

for (const file of [
  'package.json',
  'server/package.json',
  'extension/package.json',
  'packages/assets/package.json',
  'extension/manifest.json',
]) {
  const json = readJson(file);
  json.version = nextVersion;
  writeJson(file, json);
}

const mcpServerPath = resolve(rootDir, 'server/src/mcp/server.ts');
const mcpSource = readFileSync(mcpServerPath, 'utf8');
const updatedSource = mcpSource.replace(
  /new McpServer\(\{ name: 'jiranimo', version: '[^']+' \}\)/,
  `new McpServer({ name: 'jiranimo', version: '${nextVersion}' })`,
);

if (updatedSource === mcpSource) {
  throw new Error('Could not update MCP server version string');
}

writeFileSync(mcpServerPath, updatedSource);
