import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { serverConfigSchema } from './schema.js';
import type { ServerConfig } from './types.js';

const CONFIG_FILENAME = 'jiranimo.config.json';

function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string' && obj.startsWith('$')) {
    const envVar = obj.slice(1);
    const value = process.env[envVar];
    if (value === undefined) {
      throw new Error(`Environment variable ${envVar} is not set (referenced in config as "${obj}")`);
    }
    return value;
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = resolveEnvVars(value);
    }
    return resolved;
  }
  return obj;
}

function findConfigFile(searchPaths?: string[]): string {
  const paths = searchPaths ?? [
    resolve(process.cwd(), CONFIG_FILENAME),
    resolve(homedir(), '.jiranimo', CONFIG_FILENAME),
  ];

  for (const configPath of paths) {
    try {
      readFileSync(configPath, 'utf-8');
      return configPath;
    } catch {
      continue;
    }
  }

  throw new Error(
    `Config file not found. Searched:\n${paths.map(p => `  - ${p}`).join('\n')}\n\nCreate a ${CONFIG_FILENAME} file with your project mappings.`
  );
}

export function loadConfig(options?: { configPath?: string; searchPaths?: string[] }): ServerConfig {
  const configPath = options?.configPath ?? findConfigFile(options?.searchPaths);

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read config file at ${configPath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in config file ${configPath}: ${(err as Error).message}`);
  }

  const resolved = resolveEnvVars(parsed);
  const result = serverConfigSchema.safeParse(resolved);

  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config in ${configPath}:\n${issues}`);
  }

  return result.data as ServerConfig;
}
