// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // Deploying under a subpath (e.g. https://example.com/c-img/) requires setting a base.
  // Example: ASTRO_BASE="/c-img/" pnpm build
  base: process.env.ASTRO_BASE || '/tools/',
  site: process.env.ASTRO_SITE || 'https://www.ksw1024.studio/tools/',
  output: 'static',

  vite: {
    optimizeDeps: {
      exclude: ['@jsquash/avif', 'ffmpeg.wasm', '@ffmpeg/ffmpeg', '@ffmpeg/util', '@ffmpeg/core'],
    },

    worker: {
      format: 'es',
      rollupOptions: {
        external: [],
        output: {
          entryFileNames: '[name].js',
        },
      },
    },

    plugins: [tailwindcss()],

    build: {
      rollupOptions: {
        external: [],
        output: {
          manualChunks: undefined,
        },
      },
    },
  },
});