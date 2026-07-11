import { defineConfig } from 'vite';

// The core's Node crypto/ecdsa backends are swapped for browser ones
// (@noble/*) via the "browser" field of core/package.json. Buffer is polyfilled
// in main.mjs. Single entry (index.html) — wallet + Freimarkets are one app now.
export default defineConfig({
  define: { global: 'globalThis' },
});
