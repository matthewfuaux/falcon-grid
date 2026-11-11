import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = resolve(import.meta.dirname, 'targets');
const pages = Object.fromEntries(
  readdirSync(root)
    .filter((f) => f.endsWith('.html'))
    .map((f) => [f.replace('.html', ''), resolve(root, f)]),
);

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: pages,
      onwarn(warning, warn) {
        // Glide ships /*#__PURE__*/ annotations in positions Rollup ignores; harmless.
        if (warning.code === 'INVALID_ANNOTATION') return;
        warn(warning);
      },
    },
    chunkSizeWarningLimit: 4000,
  },
});
