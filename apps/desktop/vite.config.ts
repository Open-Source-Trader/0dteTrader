import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the production build works when the Electron
  // shell loads dist/index.html over file:// (absolute /assets/* 404s there).
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    // This machine's inotify watcher limit is exhausted (ENOSPC); poll instead.
    watch: { usePolling: true, interval: 700 },
  },
});
