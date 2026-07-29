import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
