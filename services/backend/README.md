# Backend (variant C)

A thin REST backend over `freicoind` RPC — the fast-path MVP data layer. The
**client owns the keys and signs locally** (using [`../../core`](../../core)); the
backend only derives addresses, reports present-value balance/UTXOs, and relays
signed transactions. Pure Node (v18+, global `fetch`), **no dependencies**.

Later this whole layer is replaced by variant B (a neutrino light client), so it
is deliberately minimal.

## Run

```sh
FW_NETWORK=regtest \
FW_RPC_URL=http://127.0.0.1:19455 \
FW_RPC_COOKIE=/path/to/datadir/regtest/.cookie \
FW_ACCOUNT_XPUB=tpub...            # account-level xpub, e.g. m/84'/coin'/0' \
node services/backend/server.mjs   # listens on FW_PORT (default 3030)
```

RPC auth: either `FW_RPC_COOKIE` (a freicoind `.cookie` file) or
`FW_RPC_USER`/`FW_RPC_PASS`.

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{ ok, network }` |
| GET | `/address?index=n&chain=0` | a receive (chain 0) or change (chain 1) address |
| GET | `/balance` | `{ balance, tipHeight, unit: "present-value" }` |
| GET | `/utxos` | `{ balance, tipHeight, utxos: [{ txid, vout, amount, nominal, refheight, coinbase, scriptPubKey }] }` |
| POST | `/broadcast` | body `{ rawtx }` → `{ txid }` |
| GET | `/tx/:txid` | `{ txid, confirmations, inMempool }` |

`amount` is the **present value** at the tip; `nominal` is the stored output
value (what the client signs over). A client builds a tx with
`lock_height = tipHeight` and spends each input at its reported `amount`, or with
`lock_height = refheight` and signs over `nominal` (present value == nominal at
distance 0). See [`../../examples/capstone.mjs`](../../examples/capstone.mjs).

## Notes / limitations (MVP)

- **Balance/UTXOs use `scantxoutset`** — simple and stateless, but it scans the
  whole UTXO set per call. Fine for regtest/MVP; for production switch to a
  watch-only descriptor wallet (`importdescriptors` + `listunspent`) or move to
  variant B.
- **`/tx` on a confirmed transaction needs `freicoind -txindex`** (without it,
  `getrawtransaction` only resolves mempool txs). Mempool status works either way.
- Single-account (one `FW_ACCOUNT_XPUB`); no multi-wallet, no auth layer yet.
