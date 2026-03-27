import { createServer } from 'node:http';
import { resolve, isAbsolute } from 'node:path';
import { watch } from 'node:fs';
import { loadConfig } from './config/loader.js';
import { configExists, runSetup } from './config/setup.js';
import { StateStore } from './state/store.js';
import { PipelineManager } from './pipeline/manager.js';
import { createApp } from './web/server.js';
import { attachWebSocket } from './web/ws-handler.js';

const DEV_MODE = process.env.JIRANIMO_MODE === 'development';

async function main() {
  if (DEV_MODE) {
    console.log('\n[DEV] Running in development mode\n');
  }

  // Load config — dev uses local file, prod uses global
  let config;
  if (DEV_MODE) {
    const devConfigPath = resolve(process.cwd(), 'jiranimo.dev.config.json');
    config = loadConfig({ configPath: devConfigPath });
    // Resolve relative repoPath against cwd
    if (!isAbsolute(config.repoPath)) {
      config = { ...config, repoPath: resolve(process.cwd(), config.repoPath) };
    }
    // Set dev-local paths
    config.statePath = config.statePath ?? resolve(process.cwd(), '.dev-state.json');
    config.logsDir = config.logsDir ?? resolve(process.cwd(), '.dev-logs');
  } else {
    if (!configExists()) {
      await runSetup();
    }
    config = loadConfig();
  }

  // State — dev uses local file, prod uses global default
  const store = new StateStore(config.statePath ? { filePath: config.statePath } : undefined);
  const pipeline = new PipelineManager(store, config);

  const app = createApp(store, pipeline);
  const server = createServer(app);
  const wsHandler = attachWebSocket(server, pipeline);

  // In dev mode, watch extension files and broadcast reload signal
  if (DEV_MODE) {
    startExtensionWatcher(wsHandler);
  }

  server.listen(config.web.port, config.web.host, () => {
    console.log(`Jiranimo server running on http://${config.web.host}:${config.web.port}`);
    console.log(`Dashboard: http://${config.web.host}:${config.web.port}`);
    console.log(`Repo path: ${config.repoPath}`);

    if (DEV_MODE) {
      console.log(`\n[DEV] Config: ${resolve(process.cwd(), 'jiranimo.dev.config.json')}`);
      console.log(`[DEV] State: ${config.statePath}`);
      console.log(`[DEV] Logs: ${config.logsDir}`);
      console.log(`[DEV] Extension auto-reload: enabled`);
    } else {
      const extensionPath = resolve(process.cwd(), '..', 'extension');
      console.log(`\nTo install the Chrome extension:`);
      console.log(`  1. Open chrome://extensions`);
      console.log(`  2. Enable "Developer mode" (top right)`);
      console.log(`  3. Click "Load unpacked"`);
      console.log(`  4. Select: ${extensionPath}`);
    }
    console.log('');
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    store.flushSync();
    store.destroy();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function startExtensionWatcher(wsHandler: ReturnType<typeof attachWebSocket>) {
  const extensionDir = resolve(process.cwd(), '..', 'extension');
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    watch(extensionDir, { recursive: true }, (_event, filename) => {
      if (!filename || filename.includes('node_modules')) return;
      // Debounce — wait 500ms for batch changes
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(`[DEV] Extension file changed: ${filename}`);
        wsHandler.send({ type: 'extension-reload' });
      }, 500);
    });
    console.log(`[DEV] Watching extension/ for changes`);
  } catch (err) {
    console.warn(`[DEV] Could not watch extension directory:`, err);
  }
}

main();
