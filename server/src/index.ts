import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { watch, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/loader.js';
import { StateStore } from './state/store.js';
import { PipelineManager } from './pipeline/manager.js';
import { createApp } from './web/server.js';
import { attachWebSocket } from './web/ws-handler.js';
import { resolveStartupPath, resolveRepoTarget } from './runtime-target.js';
import { createLogger } from './logging/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = resolve(__dirname, '..', '..', 'extension');

async function main() {
  const config = loadConfig();
  const logger = createLogger(config, 'server');
  const targetPath = resolveStartupPath();
  const repoTarget = resolveRepoTarget(targetPath);

  const store = new StateStore(config.statePath ? { filePath: config.statePath } : undefined);
  const meta = store.beginServerEpoch();
  store.flushSync();
  const pipeline = new PipelineManager(store, config, repoTarget);

  const app = createApp(store, pipeline, config);
  const server = createServer(app);
  const wsHandler = attachWebSocket(server, pipeline);

  const extensionReloadEnabled = startExtensionWatcher(wsHandler, logger.child('extension'));

  server.listen(config.web.port, config.web.host, () => {
    logger.info('Server listening', {
      url: `http://${config.web.host}:${config.web.port}`,
      dashboardUrl: `http://${config.web.host}:${config.web.port}`,
      mcpUrl: `http://${config.web.host}:${config.web.port}/mcp`,
      targetPath,
      targetMode: repoTarget.kind === 'single-repo' ? 'single-repo' : 'repo-root',
      statePath: config.statePath ?? 'default (~/.jiranimo/state.json)',
      logsDir: config.logsDir ?? 'default (~/.jiranimo/logs)',
      extensionAutoReload: extensionReloadEnabled,
      serverEpoch: meta.serverEpoch,
    });
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down');
    pipeline.shutdown();
    store.flushSync();
    store.destroy();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function startExtensionWatcher(wsHandler: ReturnType<typeof attachWebSocket>, logger = createLogger(undefined, 'server:extension')): boolean {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  if (!existsSync(EXTENSION_DIR)) {
    return false;
  }

  try {
    watch(EXTENSION_DIR, { recursive: true }, (_event, filename) => {
      if (!filename || filename.includes('node_modules')) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        logger.info('Extension file changed', { filename });
        wsHandler.send({ type: 'extension-reload' });
      }, 500);
    });
    logger.info('Watching extension directory', { path: EXTENSION_DIR });
    return true;
  } catch (err) {
    logger.warn('Could not watch extension directory', { error: (err as Error).message });
    return false;
  }
}

main().catch((err) => {
  createLogger(undefined, 'server').error('Startup failed', { error: (err as Error).message });
  process.exit(1);
});
