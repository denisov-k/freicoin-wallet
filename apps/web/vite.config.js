import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The core's Node crypto/ecdsa backends are swapped for browser ones
// (@noble/*) via the "browser" field of core/package.json. Buffer is polyfilled
// in main.mjs. Single entry (index.html) — wallet + Freimarkets are one app now.
//
// Path aliases keep imports stable across the src/ folder tree (views/, components/,
// state/, services/…): `@core` = the shared consensus package (sibling of apps/),
// `@` = this client's src root — so a file's depth never dictates its import paths.
export default defineConfig({
  define: { global: 'globalThis' },
  // two pages: the wallet (index.html) and the share credit market (market.html, served at /market)
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        market: fileURLToPath(new URL('./market.html', import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('../../core', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
