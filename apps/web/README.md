# Web wallet (variant C)

A browser wallet for Freicoin. Keys live in the browser; it derives addresses and
signs transactions locally with [`../../core`](../../core), and talks to the
[variant-C backend](../../services/backend) for balance/UTXOs/broadcast.

The core's Node `crypto` backend is swapped for a browser one (`@noble/hashes`)
via `core/package.json`'s `"browser"` field and a Vite alias; `Buffer` is
polyfilled. The `@noble` hashes are byte-for-byte identical to Node's, so the
core behaves identically in the browser.

## Develop

```sh
npm install
npm run dev          # vite dev server
npm run build        # production bundle -> dist/
```

Point it at a running backend and Freicoin node: open **Settings** (⚙) in the app
and set the backend URL (default `http://127.0.0.1:3030`) and a seed. Screens:
**Balance** (present value), **Receive** (HD addresses), **Send** (refheight-aware
coin selection, MAST wpk signing, broadcast).

## Notes

- The seed is stored in `localStorage` for the MVP — **insecure**, dev/regtest
  only. A production wallet needs proper key storage (Web Crypto + a passphrase,
  or a hardware/PST signer).
- The core's pure-JS secp256k1 is correct but slow for the gap-limit key scan;
  a production build should alias `core/ecdsa.mjs`'s point multiplication to a
  native/optimized library (e.g. `@noble/secp256k1`) the same way the hashes are.
