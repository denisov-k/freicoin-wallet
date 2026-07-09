# freicoin-wallet

A wallet for [Freicoin](https://github.com/tradecraftio/tradecraft) — the
demurrage cryptocurrency. This repository holds the validated **wallet core**
(the parts no off-the-shelf Bitcoin library gets right for Freicoin) and, over
time, the **React Native app** and a thin backend that build on it.

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
| `sighash.mjs` | Freicoin SegwitV0 signature hash | 120/120 |
| `ecdsa.mjs` | secp256k1 sign (RFC6979) / verify / pubkey | 160/160 |
| `hd.mjs` | BIP32/44/84 HD derivation + wpk addresses | 11/11 |

**End-to-end:** [`examples/capstone.mjs`](examples/capstone.mjs) builds a fully
signed transaction from these modules and a live regtest `freicoind` accepts it
(`sendrawtransaction`, mined into a block) — the whole "send money" path proven
against a real node.

## Running the tests

Pure Node (v18+), no dependencies:

```sh
npm test                        # runs every harness in core/test/
# or without npm:
node core/test/run-all.mjs
```

The `gen_*.py` scripts regenerate the golden vectors from a checked-out
Freicoin/Tradecraft tree (`test_framework` on the path); the committed `*.json`
vectors let the harnesses run without it.

## Architecture (planned)

The core is architecture-neutral. The wallet ships in two stages:

- **C (now):** a thin backend over `freicoind` RPC + the RN app — fastest path to
  a working, demurrage-correct wallet.
- **B (destination):** a neutrino (BIP157/158) light client that drops the
  trusted backend, reusing the same core and UI. Freicoin nodes already serve
  compact block filters (`-peerblockfilters`) and carry `libbitcoinkernel`.

See [`../drafts/rn-wallet-design.md`](../drafts/rn-wallet-design.md) for the full
design rationale (kept alongside during prototyping).

## Layout

```
core/            validated wallet-core modules
core/test/       harnesses, vector generators, golden vectors
examples/        capstone.mjs — end-to-end signed tx against a node
research/        related experiments (Lightning payment-channel prototypes)
```
