import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PipelineManager } from '../pipeline/manager.js';
import type { StateStore } from '../state/store.js';
import { createApiRouter } from './api-routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(store: StateStore, pipeline: PipelineManager) {
  const app = express();

  // CORS — allow requests from Jira and any origin (local tool, not public)
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.use(express.json());

  // Request logging (after JSON parsing so body is available)
  app.use((req, _res, next) => {
    // Skip noisy polling requests
    if (req.method === 'GET' && req.url === '/tasks') { next(); return; }
    console.log(`${req.method} ${req.originalUrl}`);
    if (req.method === 'POST' && req.body) {
      console.log(`  Body: ${JSON.stringify(req.body).slice(0, 300)}`);
    }
    next();
  });

  // API routes
  app.use('/api', createApiRouter(store, pipeline));

  // Serve static dashboard
  app.use(express.static(resolve(__dirname, 'public')));

  return app;
}
