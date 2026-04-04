import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PipelineManager } from '../pipeline/manager.js';
import type { StateStore } from '../state/store.js';
import { createApiRouter } from './api-routes.js';
import { createMcpHandler } from '../mcp/server.js';
import type { ServerConfig } from '../config/types.js';
import { createLogger, resolveLoggingConfig } from '../logging/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(store: StateStore, pipeline: PipelineManager, config?: Pick<ServerConfig, 'logsDir' | 'logging'>) {
  const app = express();
  const logger = createLogger(config, 'http');
  const loggingConfig = resolveLoggingConfig(config);

  // CORS — allow requests from Jira and any origin (local tool, not public)
  // Access-Control-Allow-Private-Network is required by Chrome's Private Network
  // Access policy when a public origin (e.g. atlassian.net) fetches localhost.
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Private-Network', 'true');
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.use(express.json());

  // Request logging (after JSON parsing so body is available).
  app.use((req, res, next) => {
    if (!loggingConfig.logHttpRequests || shouldSkipHttpLog(req.method, req.path)) {
      next();
      return;
    }

    const startedAt = Date.now();
    res.on('finish', () => {
      const meta: Record<string, unknown> = {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      };

      if (loggingConfig.logHttpBodies && req.method !== 'GET' && hasBody(req.body)) {
        meta.body = JSON.stringify(req.body).slice(0, 300);
      }

      logger.info('HTTP request', meta);
    });

    next();
  });

  // MCP endpoint — Claude Code connects here to call back into the pipeline
  const mcpHandler = createMcpHandler(pipeline);
  app.all('/mcp', (req, res) => { void mcpHandler(req, res); });

  // API routes
  app.use('/api', createApiRouter(store, pipeline));

  // Serve static dashboard
  app.use(express.static(resolve(__dirname, 'public')));

  return app;
}

export function shouldSkipHttpLog(method: string, path: string): boolean {
  if (path === '/mcp') return true;
  if (!path.startsWith('/api')) return true;
  if (method === 'GET' && (path === '/api/tasks' || path === '/api/sync')) return true;
  if (method === 'GET' && /^\/api\/tasks\/[^/]+$/.test(path)) return true;
  if (/^\/api\/effects\/[^/]+\/(claim|ack)$/.test(path)) return true;
  return false;
}

function hasBody(body: unknown): boolean {
  if (body == null) return false;
  if (typeof body !== 'object') return true;
  return Object.keys(body as Record<string, unknown>).length > 0;
}
