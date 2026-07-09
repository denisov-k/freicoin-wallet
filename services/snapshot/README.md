# snapshot — fast first-sync header bootstrap

The header chain is identical for every wallet and the client verifies it
cryptographically, so its delivery channel needs no trust — it can be a static
file. Serving one is far cheaper for the host than per-user P2P serialization
through the bridge, and much faster for the user.

- **`make.mjs`** builds the snapshot: it syncs and **fully verifies** the chain
  through the wallet's own client code (linkage, native PoW, parallel aux-pow),
  capturing every raw P2P `headers` message into the output file (written to
  `.tmp`, renamed only after verification passes). The wallet re-verifies
  everything on consumption anyway.

  ```sh
  node make.mjs main ws://127.0.0.1:3041 <genesis-hash> /root/fw-snapshots/main-headers.bin
  ```

- **`serve.mjs`** is a tiny static server (CORS-open, Range requests, cache
  headers) for the snapshot directory:

  ```sh
  FW_SNAP_DIR=/root/fw-snapshots FW_SNAP_PORT=3050 node serve.mjs
  ```

The wallet fetches the snapshot on a fresh start (build-time `VITE_SNAP_MAIN`),
streams it through the same decoder and verification as P2P data, then catches
the tail up over P2P. A stale snapshot is harmless (longer tail); a missing or
corrupt one falls back to pure P2P silently.
