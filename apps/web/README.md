# Web wallet — trustless neutrino light client

A browser wallet for Freicoin with **no trusted backend**. Keys live on the main
thread; the entire light client (network, verification, scanning, persistence)
runs in a Web Worker.

## Trust model

| Piece | Can it lie? |
|---|---|
| p2p-bridge (WS↔TCP relay) | can censor/observe, **cannot forge** — headers fail PoW, blocks fail their hash |
| header snapshot (static HTTP) | same — verified identically to P2P data; any error falls back to P2P |
| a single filter peer | could *hide* a payment — mitigated by multi-peer filter agreement (list several bridge URLs in Settings, comma-separated); ≥1 honest peer ⇒ nothing can be hidden |
| the app host | trusted for the code itself, as with any web app |

Everything else is verified client-side: header linkage, native PoW, Freicoin's
merged-mining **aux-pow** (a byte-exact port of `GetAuxiliaryHash`), BIP158
Golomb-set matching, block hashes, demurrage present values.

## Sync pipeline (first sync ≈ a minute, then incremental)

All fronts overlap; nothing waits for anything sequentially:

1. **Snapshot bootstrap** — the header chain streams from a static file and is
   verified batch-by-batch; a P2P `getheaders` catch-up fetches the tail.
2. **Scan follower** — trails the header front over a second WebSocket: filters
   are fetched, matched and matched blocks scanned per 1000-block stride,
   streaming the balance found so far to the UI from the first second.
3. **Worker pool** — aux-pow verification *and* GCS filter matching fan out to
   sub-workers (≈ CPU cores). `verifiedHeight` trails the tip and gates
   persistence, so an unverified chain never survives a reload.

State (compact columnar header chain + UTXO set) persists in IndexedDB with
mid-sync checkpoints; reloads resume in ~2s. The wallet's **birth height is
automatic**: recorded at generation for new wallets, learned from the first
completed scan for imported ones. Unconfirmed incoming/outgoing transactions
appear instantly via P2P mempool watch (`inv`→`tx`).

## Screens

**Balance** (present value, streamed while syncing) · **Receive** (HD `wpk`
addresses + QR) · **Send** (refheight-aware coin selection, MAST wpk signing —
builds only on verified data) · **Activity** (history + pending) · **Settings**
(theme, network regtest/testnet/mainnet, bridge URL(s), secret). The header
status dot shows amber = syncing / green = verified / red = offline; click it
for details (network, downloaded MB + MB/s, per-phase progress).

## Develop

```sh
npm install
npm run dev          # vite dev server
npm run build        # production bundle -> dist/
```

Build-time endpoints (defaults point at localhost):

```sh
VITE_BRIDGE=ws://host:3040        # regtest bridge
VITE_BRIDGE_MAIN=ws://host:3041   # mainnet bridge
VITE_SNAP_MAIN=http://host:3050/main-headers.bin   # header snapshot (optional)
```

You need a Freicoin node with `-blockfilterindex=1 -peerblockfilters=1`, a
[`p2p-bridge`](../../services/p2p-bridge) pointed at it, and optionally a
[snapshot](../../services/snapshot) for fast first syncs.

## Notes

- The secret can be encrypted with a passphrase (PBKDF2 + AES-GCM via `@noble`,
  works on plain http); unencrypted storage is for dev/regtest only.
- The core's crypto/ecdsa swap to `@noble` in the browser via
  `core/package.json`'s `"browser"` field; outputs are byte-identical to Node.
- A full trustless first sync downloads ~95 MB of headers+proofs — that is the
  price of verifying a merged-mined chain from genesis; it is one-time and
  could only shrink via protocol-level compact proofs (NiPoPoW-style) or by
  reintroducing trust (baked-in checkpoints), which this wallet refuses.
