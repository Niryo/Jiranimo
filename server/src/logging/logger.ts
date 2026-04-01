import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { LoggingConfig, LogLevel, ServerConfig } from '../config/types.js';

export const DEFAULT_LOGGING_CONFIG: LoggingConfig = {
  level: 'info',
  logHttpRequests: true,
  logHttpBodies: false,
  logClaudeRawOutput: false,
};

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  child(scope: string): Logger;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  isConsoleLevelEnabled(level: LogLevel): boolean;
  getConfig(): LoggingConfig;
}

class AppLogger implements Logger {
  private readonly config: LoggingConfig;
  private readonly filePath: string;
  private readonly scope?: string;

  constructor(serverConfig?: Pick<ServerConfig, 'logsDir' | 'logging'>, scope?: string) {
    this.config = resolveLoggingConfig(serverConfig);
    const logsDir = serverConfig?.logsDir ?? resolve(homedir(), '.jiranimo', 'logs');
    mkdirSync(logsDir, { recursive: true });
    this.filePath = join(logsDir, 'server.log');
    this.scope = scope;
  }

  child(scope: string): Logger {
    const nextScope = this.scope ? `${this.scope}:${scope}` : scope;
    return new AppLogger({ logsDir: dirname(this.filePath), logging: this.config }, nextScope);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  isConsoleLevelEnabled(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.config.level];
  }

  getConfig(): LoggingConfig {
    return this.config;
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const line = formatLogLine(level, this.scope, message, meta);

    try {
      appendFileSync(this.filePath, `${line}\n`, 'utf-8');
    } catch {
      // Keep the app running even if the log file is unavailable.
    }

    if (!this.isConsoleLevelEnabled(level)) {
      return;
    }

    if (level === 'error') {
      console.error(line);
      return;
    }
    if (level === 'warn') {
      console.warn(line);
      return;
    }
    console.log(line);
  }
}

export function createLogger(serverConfig?: Pick<ServerConfig, 'logsDir' | 'logging'>, scope?: string): Logger {
  return new AppLogger(serverConfig, scope);
}

export function resolveLoggingConfig(serverConfig?: Pick<ServerConfig, 'logging'>): LoggingConfig {
  return {
    ...DEFAULT_LOGGING_CONFIG,
    ...(serverConfig?.logging ?? {}),
  };
}

export function isSuppressedChildProcessLogLine(line: string): boolean {
  return [
    /chrome\/updater\//i,
    /GoogleUpdater/i,
    /VERBOSE\d?:chrome\//i,
  ].some((pattern) => pattern.test(line));
}

function formatLogLine(
  level: LogLevel,
  scope: string | undefined,
  message: string,
  meta?: Record<string, unknown>,
): string {
  const parts = [new Date().toISOString(), level.toUpperCase()];
  if (scope) parts.push(`[${scope}]`);
  parts.push(message);

  const metaJson = serializeMeta(meta);
  if (metaJson) parts.push(metaJson);

  return parts.join(' ');
}

function serializeMeta(meta?: Record<string, unknown>): string {
  if (!meta) return '';
  const entries = Object.entries(meta).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return '';
  return JSON.stringify(Object.fromEntries(entries));
}
