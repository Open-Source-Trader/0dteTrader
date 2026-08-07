import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const packageVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const buildIdentifier = process.env.RELEASE_SHA ?? process.env.GITHUB_SHA ?? 'development';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageVersion),
    __BUILD_IDENTIFIER__: JSON.stringify(buildIdentifier),
  },
  // shared-types ships CJS; without prebundling, Vite dev serves it raw and
  // named imports (e.g. chartOrderCrossed) throw at module load. The linked
  // workspace package is excluded from optimizeDeps by default — opt it in.
  optimizeDeps: { include: ['@0dtetrader/shared-types'] },
  // Relative asset paths so the production build works when the Electron
  // shell loads dist/index.html over file:// (absolute /assets/* 404s there).
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    // This machine's inotify watcher limit is exhausted (ENOSPC); poll instead.
    // 1s balances CPU usage against noticeable save-to-reload lag.
    watch: { usePolling: true, interval: 1000 },
  },
});
