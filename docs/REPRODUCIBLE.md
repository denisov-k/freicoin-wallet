# Reproducible builds — verify what freicoin.ru serves you

A browser wallet is only as trustworthy as the JavaScript the server delivers. This repo's
production bundle is **reproducible**: anyone can rebuild it from source and confirm the
deployed code is byte-identical — no hidden key-stealing patch, no per-user targeting.

## Verify in one command

```bash
git clone https://github.com/denisov-k/freicoin-wallet
cd freicoin-wallet
bash scripts/verify-build.sh
```

Expected output ends with:

```
OK   index-XXXXXXXX.js   sha256=…
OK   index-XXXXXXXX.css  sha256=…
✅ REPRODUCIBLE: the served bundle is byte-identical to this source tree.
```

Requirements: `node` ≥ 20, `npm`, `curl`. Dependencies are lockfile-pinned (`npm ci`), so the
toolchain (Vite/Rollup versions) is fixed by the repository itself.

## What exactly is proven

- The served `index-*.js` / `index-*.css` are built from the checked-out source tree —
  every byte of application logic, crypto, and networking code matches this repo.
- The **one** legitimate per-build input is the mainnet fast-sync checkpoint
  (`height:blockhash`, baked at build time so new wallets sync in seconds instead of hours).
  The verify script extracts it *from the deployed bundle* and rebuilds with the same value,
  so it cannot hide a code change. The checkpoint itself is printed at the end — check the
  block hash against any independent Freicoin node:

  ```bash
  freicoin-cli getblockhash <height>   # must equal the printed hash
  ```

  A wrong checkpoint cannot steal funds (all headers/filters are still PoW-verified by the
  light client); the worst it could do is pin the wallet to a fake chain, which the hash
  comparison above rules out.

- `index.html` is tiny and non-hashed — read it directly (view-source): it must reference
  only the verified assets and contain no inline script.

## Scope and honesty

- Verification proves the *moment you ran it*. A malicious server could in principle serve
  different bytes to different visitors; repeated spot-checks from different networks (Tor,
  VPN, a friend's machine) close that gap. The asset filenames contain a content hash, so a
  targeted swap also changes the URL in `index.html` — easy to catch.
- The service worker and manifest are small static files, readable the same way.
- The relay server code (`research/nversion3/market-server.mjs`) is in this repo too, but a
  relay is **untrusted by design**: it never holds keys or funds; every swap is protected by
  HTLC timelocks enforced on-chain. You don't need to verify what the relay runs — only what
  your browser runs.
