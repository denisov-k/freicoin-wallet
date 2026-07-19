# Running your own market relay

The exchange (order book + BTC↔FRC swap coordination) is served by a **relay** —
`research/nversion3/market-server.mjs`. The relay at freicoin.ru is just the default
instance; nothing about it is privileged. This page shows how to run your own and point
the wallet at it, so the market survives any single server going away.

## Trust model — what a relay can and cannot do

A relay is **untrusted by design**:

- it never holds keys or funds — swaps are HTLCs, enforced on-chain by both networks;
- if it dies mid-swap, wallets refund themselves via the timelock branches;
- the worst a malicious relay can do is show a fake order book or refuse service —
  it cannot steal (maker signatures pin destinations and price floors).

What you centralize by using one relay is *market availability*, not money. Note that
each relay carries its **own** order book — two relays are two separate markets.

## Prerequisites

| Piece | Why | Size / notes |
|---|---|---|
| Freicoin node (with `-txindex` off is fine) | index the FRC chain, broadcast txs | full chain ~a few GB; [tradecraftio/tradecraft](https://github.com/tradecraftio/tradecraft) |
| Bitcoin Core node | detect HTLC fundings, estimate fees, broadcast | **pruned works** (`prune=10000`, ~10 GB); `-server=1` |
| Node.js ≥ 20 | run the relay | no npm dependencies — the relay is a single self-contained file |

The relay reads both nodes' RPC via the `.cookie` files in their datadirs — run it as a
user that can read those.

Create two wallets on the Bitcoin node once (watch-only detection + optional bot wallet):

```sh
bitcoin-cli createwallet p2pwatch true   # watch-only: HTLC-funding detection
bitcoin-cli createwallet swap            # optional: only if you run the liquidity bot
```

## Configuration (environment)

Everything is an env var; the important ones:

| Var | Meaning | Example (mainnet) |
|---|---|---|
| `FRC_NET` | Freicoin network (`main`/`test`/`regtest`) | `main` |
| `NV3_DATADIR` | Freicoin datadir (for the RPC cookie) | `/home/fm/.freicoin` |
| `NV3_RPCPORT` | Freicoin RPC port | `8638` |
| `NV3_LISTEN` | relay HTTP port | `5183` |
| `BTC_NET` | Bitcoin network (`main`/`signet`/`regtest`) | `main` |
| `BTC_DATADIR` | Bitcoin datadir (cookie) | `/home/fm/.bitcoin` |
| `BTC_RPCPORT` | Bitcoin RPC port | `8332` |
| `BTC_WATCH_WALLET` | watch-only wallet name | `p2pwatch` |
| `BTC_MINCONF` | confirmations before trusting a funding | `2` |
| `BTC_MAX_SWAP` | training-wheel cap on a swap's BTC side, sats (0 = off) | `200000` |

The relay persists its state (order book, swap records, VAPID push keys) in
`NV3_DATADIR` as small JSON files — back that up if you care about open offers.

## Run it

```sh
git clone https://github.com/denisov-k/freicoin-wallet && cd freicoin-wallet
FRC_NET=main NV3_DATADIR=$HOME/.freicoin NV3_RPCPORT=8638 NV3_LISTEN=5183 \
BTC_NET=main BTC_DATADIR=$HOME/.bitcoin BTC_RPCPORT=8332 \
node research/nversion3/market-server.mjs
```

Health check: `curl http://localhost:5183/api/p2pList` → JSON with `"available":true`.

A production systemd unit (mirrors the freicoin.ru one):

```ini
[Unit]
Description=Freimarkets relay (FRC main <-> BTC main)
After=network.target freicoind.service bitcoind.service

[Service]
WorkingDirectory=/opt/freicoin-wallet
Environment=FRC_NET=main NV3_DATADIR=/home/fm/.freicoin NV3_RPCPORT=8638 NV3_LISTEN=5183
Environment=BTC_NET=main BTC_DATADIR=/home/fm/.bitcoin BTC_RPCPORT=8332 BTC_MINCONF=2 BTC_MAX_SWAP=200000
ExecStart=/usr/bin/node research/nversion3/market-server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

For public exposure put TLS in front (nginx/caddy proxy to `:5183`); CORS is already
open (`Access-Control-Allow-Origin: *`), so any wallet origin can use your relay.
Rate limits: `RL_READ` (240 req/min/IP) and `RL_WRITE` (20/min/IP).

## Point the wallet at it

Wallet → **Settings** → *Market relay URL (order book & swaps)* →
`https://your.host/api` (or `http://host:5183/api` for LAN use). The wallet
health-checks the URL before saving; empty field returns to the site default.
The override is per-network, so a custom mainnet relay doesn't affect the demo chains.

Web-push «your turn» notifications come from whichever relay you use (it generates its
own VAPID keys on first start) — re-enable notifications after switching.

## Verify it end-to-end

1. `curl https://your.host/api/p2pList` — `"available":true`, sane `frcHeight`/`btcHeight`.
2. In the wallet, set the relay URL — the exchange board should repaint from your relay.
3. Post a tiny offer and cancel it — both actions should reflect on `p2pList`.
