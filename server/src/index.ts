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

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = resolve(__dirname, '..', '..', 'extension');

async function main() {
  const config = loadConfig();
  const targetPath = resolveStartupPath();
  const repoTarget = resolveRepoTarget(targetPath);

  const store = new StateStore(config.statePath ? { filePath: config.statePath } : undefined);
  const meta = store.beginServerEpoch();
  store.flushSync();
  const pipeline = new PipelineManager(store, config, repoTarget);

  const app = createApp(store, pipeline);
  const server = createServer(app);
  const wsHandler = attachWebSocket(server, pipeline);

  const extensionReloadEnabled = startExtensionWatcher(wsHandler);

  server.listen(config.web.port, config.web.host, () => {
    console.log(`Jiranimo server running on http://${config.web.host}:${config.web.port}`);
    console.log(`Dashboard: http://${config.web.host}:${config.web.port}`);
    console.log(`Target path: ${targetPath}`);
    console.log(`Target mode: ${repoTarget.kind === 'single-repo' ? 'single-repo' : 'repo-root'}`);
    console.log(`MCP endpoint: http://${config.web.host}:${config.web.port}/mcp`);
    console.log(`State: ${config.statePath ?? 'default (~/.jiranimo/state.json)'}`);
    console.log(`Logs: ${config.logsDir ?? 'default (~/.jiranimo/logs)'}`);
    console.log(`Extension auto-reload: ${extensionReloadEnabled ? 'enabled' : 'disabled'}`);
    console.log(`Server epoch: ${meta.serverEpoch}`);
    console.log('');
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    pipeline.shutdown();
    store.flushSync();
    store.destroy();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function startExtensionWatcher(wsHandler: ReturnType<typeof attachWebSocket>): boolean {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  if (!existsSync(EXTENSION_DIR)) {
    return false;
  }

  try {
    watch(EXTENSION_DIR, { recursive: true }, (_event, filename) => {
      if (!filename || filename.includes('node_modules')) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(`Extension file changed: ${filename}`);
        wsHandler.send({ type: 'extension-reload' });
      }, 500);
    });
    console.log(`Watching extension/ for changes`);
    return true;
  } catch (err) {
    console.warn(`Could not watch extension directory:`, err);
    return false;
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
