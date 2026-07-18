import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // This machine's inotify watcher limit is exhausted (ENOSPC); poll instead.
    watch: { usePolling: true, interval: 700 },
  },
});
