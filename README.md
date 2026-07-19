# freicoin-wallet

A **trustless browser wallet** for
[Freicoin](https://github.com/tradecraftio/tradecraft) — the demurrage
cryptocurrency — with a built-in **peer-to-peer exchange**. The wallet is a
neutrino (BIP157/158) light client that runs entirely in the browser: it
downloads headers, verifies every proof-of-work (including Freicoin's
merged-mining aux-pow), matches compact block filters and scans matched blocks
itself. The hosted pieces — byte relays, a static snapshot, an order-book
relay — are all **untrusted**: nothing they say is believed without proof.

This repository holds the web app, the validated **wallet core** (the parts no
off-the-shelf Bitcoin library gets right for Freicoin), the executable
**reference model** of the nVersion=3 asset consensus, and the small services
around them.

**Live: <https://freicoin.ru>** — mainnet by default; a new wallet syncs in
about a second, and everything (headers, merged-mining proofs-of-work, compact
block filters) is verified in your browser.

## Why a Freicoin-specific core

Freicoin is a fork of Bitcoin with consensus differences that break stock
Bitcoin wallet libraries. Every one below is handled and tested here:

- **Demurrage.** A balance is a *present value* that decays continuously; every
  amount is `timeAdjustValue(nominal, now − refheight)`.
- **lock_height / refheight.** Each transaction carries a `lock_height`
  (committed in the txid) that must be ≥ every spent coin's `refheight`.
- **bech32m for witness v0** (not bech32), HRP `fc`/`tf`/`fcrt`.
- **`wpk` descriptor** (not `wpkh`); the witness-v0 program is a **MAST
  short-hash** `RIPEMD160(HASH256(0x00 ‖ <pubkey> OP_CHECKSIG))`, *not*
  `hash160(pubkey)`.
- **Transaction serialization:** trailing `uint32 lock_height` after nLockTime;
  segwit marker byte `0xff` (not `0x00`).
- **SegwitV0 sighash:** carries `amount` **and** `refheight`, plus `lock_height`,
  and masks the Freicoin-only `SIGHASH_NO_LOCK_HEIGHT` (0x100) flag.
- **PST** (not PSBT): magic `pst\xff` (4 bytes), embedded Freicoin transaction.

## The exchange (Freimarkets)

The wallet's Exchange tab implements the 2013
[*Freimarkets*](https://freico.in/docs/freimarkets.pdf) design on an
experimental chain — the **Freimarkets network** in the wallet's network
selector:

- **User-issued assets** with per-asset demurrage or interest, issued and
  transferred as ordinary transactions (the asset tag rides inside the
  scriptPubKey as a Forward-Blocks-§XI extension suffix — a soft-fork overlay).
- **Smart-property tokens** (commitment-only chainstate, two-sided reveal).
- **A miner-matched DEX**: ranged partial-fill offers whose signatures commit a
  price/bounds *descriptor*, pre-signed **rung ladders** so a maker can go
  offline, and a permissionless matcher that splices crossing offers.
- **Cross-chain BTC ↔ FRC atomic swaps** (3-branch HTLC, taker-first
  anti-griefing protocol) coordinated by an untrusted relay — live between the
  rehearsal chain and Bitcoin signet, mainnet launch pending.

The normative protocol description is
[`docs/nv3-lite-spec.md`](docs/nv3-lite-spec.md); the matching C++ node lives on
the [`nv3-lite`](https://github.com/denisov-k/tradecraft/tree/nv3-lite) branch.
The JS reference model (`core/assets.mjs`, `core/dex.mjs`, `core/nv3chain.mjs`,
…) is mirrored bit-for-bit against that node and mutation-fuzzed.

## Core stones (all validated)

Each module in [`core/`](core/) is validated by a harness in
[`core/test/`](core/test/) — against golden vectors from Freicoin's own
consensus-bit-exact python reference, or against a live `freicoind`.

| Module | What it does | Checks |
|---|---|---|
| `demurrage.mjs` | bit-exact `TimeAdjustValueForward` (present value) | 211/211 |
| `address.mjs` | bech32m witness + base58check (encode/decode) | 6/6 (vs node) |
| `tx.mjs` | parse/serialize Freicoin transactions + txid | 7/7 |
| `balance.mjs` | present-value balance over UTXOs | — |
| `coinselect.mjs` | refheight-aware coin selection + fee math | 2014/2014 |
| `pst.mjs` | PST parse/serialize (Freicoin's BIP174 fork) | 41/41 |
| `sighash.mjs` | Freicoin SegwitV0 + `SIGHASH_BUNDLE` + ranged digests | 120/120 |
| `ecdsa.mjs` | secp256k1 sign (RFC6979) / verify / pubkey | 160/160 |
| `hd.mjs` | BIP32/44/84 HD derivation + wpk addresses | 11/11 |
| `assets.mjs` `nv3chain.mjs` | nVersion=3 asset consensus (executable model) | model = spec |
| `dex.mjs` `htlc.mjs` `btc.mjs` | DEX bundles/ranged offers, HTLC swaps, BTC dialect | fuzzed + e2e |

**End-to-end:** [`examples/capstone.mjs`](examples/capstone.mjs) builds a fully
signed transaction from these modules and a live regtest `freicoind` accepts it;
the `research/nversion3/*_demo.mjs` scripts prove issuance, token transfers,
ranged fills, offline-maker ladders, options and auctions with real signatures
on a live chain.

## Reproducible builds — verify what the site serves

The production bundle is deterministic. Anyone can prove that
<https://freicoin.ru> serves exactly the code in this repository:

```sh
bash scripts/verify-build.sh
```

It rebuilds the app from source (lockfile-pinned) and byte-compares every
asset against the deployed copy. Details and the trust model:
[docs/REPRODUCIBLE.md](docs/REPRODUCIBLE.md).

## Running your own market relay

The exchange relay is a swappable, untrusted provider — anyone can run one
(pruned Bitcoin node is enough) and point the wallet at it in Settings:
[docs/RELAY.md](docs/RELAY.md).

## Running the tests

Pure Node (v18+), no dependencies:

```sh
npm test                        # core harnesses (core/test/)
node apps/web/test/run-tests.mjs  # app suite: 26 files — light client, swaps,
                                  # DEX, mutation fuzzers (needs the regtest infra)
```

The `gen_*.py` scripts regenerate the golden vectors from a checked-out
Freicoin/Tradecraft tree (`test_framework` on the path); the committed `*.json`
vectors let the harnesses run without it.

## Architecture

```
browser                                   host (untrusted)
┌─────────────────────────────────┐
│ main thread: UI + KEYS + signing│
│   ↕ postMessage (scripts only)  │      ┌───────────────────┐
│ Web Worker: neutrino client     │─WS──▶│ p2p-bridge (bytes) │──TCP──▶ freicoind
│   headers · filters · scan ·    │─HTTP▶│ snapshot (static)  │        (-peerblockfilters)
│   IndexedDB persistence         │      │ order-book relay   │──RPC──▶ freicoind/bitcoind
│   ↕ sub-worker pool             │      └───────────────────┘
│   aux-pow verify + GCS matching │
└─────────────────────────────────┘
```

- The **seed never leaves the main thread**; the worker only receives watch
  scripts and broadcasts already-signed transactions.
- The **bridge** is a WebSocket↔TCP byte relay (browsers can't open raw TCP);
  it can censor or observe, but not forge — every header's PoW is verified
  client-side, filters are cross-checked, blocks are self-authenticating.
- The **snapshot** is a static dump of the header chain for fast first syncs;
  it goes through the exact same verification as P2P data.
- The **order-book relay** carries offers and coordinates swaps, but every
  signature pins price, bounds and destinations — it can refuse service, never
  steal. Swap-turn web-push notifications are best-effort hints.
- Multiple bridge URLs (comma-separated in Settings) enable **multi-peer filter
  agreement**: as long as one peer is honest, a payment cannot be hidden.

First sync ≈ one minute (all phases overlap: snapshot/header download, filter
scan, parallel PoW verification), streaming the balance found so far from the
first second; afterwards everything is incremental and resumes from IndexedDB.

## Layout

```
core/                 validated wallet-core + nv3 reference model (environment-neutral)
core/test/            harnesses, vector generators, golden vectors
docs/                 nv3-lite protocol specification
apps/web/             the wallet (Vite, vanilla JS, Web Worker light client)
apps/web/src/views/     screens: dashboard, send, exchange, issue, settings, auth
apps/web/src/services/  wallet, vault, i18n, push, market/ (swaps), light/ (neutrino)
apps/web/src/state/     shared market context + network params
apps/web/test/        app suite: light client, swaps, DEX + mutation fuzzers
apps/web/landing/     the /about page (deployed copy: /var/www/fw-landing)
services/p2p-bridge   WebSocket↔TCP byte relay
services/snapshot     header-snapshot generator + static server
examples/             capstone.mjs — end-to-end signed tx against a node
research/nversion3/   order-book relay (market-server.mjs), live e2e demos, web-push
research/             earlier experiments (Lightning payment-channel prototypes)
```
