import { defineConfig } from 'vite';

// The core's Node crypto/ecdsa backends are swapped for browser ones
// (@noble/*) via the "browser" field of core/package.json. Buffer is polyfilled
// in main.mjs. Nothing else is needed here.
import { resolve } from 'node:path';

export default defineConfig({
  define: { global: 'globalThis' },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        market: resolve(import.meta.dirname, 'market.html'),
      },
    },
  },
});
