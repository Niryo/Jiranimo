import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PipelineManager } from '../pipeline/manager.js';
import type { StateStore } from '../state/store.js';
import { createApiRouter } from './api-routes.js';
import { createMcpHandler } from '../mcp/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(store: StateStore, pipeline: PipelineManager) {
  const app = express();

  // CORS — allow requests from Jira and any origin (local tool, not public)
  // Access-Control-Allow-Private-Network is required by Chrome's Private Network
  // Access policy when a public origin (e.g. atlassian.net) fetches localhost.
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Private-Network', 'true');
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.use(express.json());

  // Request logging (after JSON parsing so body is available)
  app.use((req, _res, next) => {
    // Skip noisy polling requests and MCP traffic
    if (req.method === 'GET' && req.url === '/tasks') { next(); return; }
    if (req.url === '/mcp') { next(); return; }
    console.log(`${req.method} ${req.originalUrl}`);
    if (req.method === 'POST' && req.body) {
      console.log(`  Body: ${JSON.stringify(req.body).slice(0, 300)}`);
    }
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
