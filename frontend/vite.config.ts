import { defineConfig } from 'vite';

// Relative asset paths, so the same build loads from Tauri's and Electron's custom protocols.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      // The app, and the phase 0 measurement harness that bench/ drives.
      input: { index: 'index.html', bench: 'bench.html' },
    },
  },
  worker: {
    format: 'es',
  },
});
