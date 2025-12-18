// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // Deploying under a subpath (e.g. https://example.com/c-img/) requires setting a base.
  // Example: ASTRO_BASE="/c-img/" pnpm build
  base: process.env.ASTRO_BASE || '/c-img/',
  site: process.env.ASTRO_SITE,
  output: 'static',

  vite: {
    optimizeDeps: {
      exclude: ['@jsquash/avif'],
    },

    worker: {
      format: 'es',
    },

    plugins: [tailwindcss()],
  },
});