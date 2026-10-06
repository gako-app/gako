import { defineConfig } from 'vite';

// Relative asset paths, so the same build loads from Tauri's and Electron's custom protocols.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
  worker: {
    format: 'es',
  },
});
