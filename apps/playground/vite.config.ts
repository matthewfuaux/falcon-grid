import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        grid: resolve(import.meta.dirname, 'index.html'),
        logs: resolve(import.meta.dirname, 'logs.html'),
        chat: resolve(import.meta.dirname, 'chat.html'),
      },
    },
  },
});
