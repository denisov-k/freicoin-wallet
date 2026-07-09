import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';

// Swap the core's Node crypto backend for the browser one, and polyfill Buffer.
const cryptoWeb = fileURLToPath(new URL('../../core/crypto.web.mjs', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /\/core\/crypto\.mjs$/, replacement: cryptoWeb }],
  },
  define: { global: 'globalThis' },
});
