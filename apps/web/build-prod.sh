#!/usr/bin/env bash
# build-prod.sh — the CANONICAL production build for freicoin.ru (the unified Freimarkets app).
#
# A bare `vite build` bakes the DEFAULT_BRIDGE fallbacks (ws://127.0.0.1:304x), which are
# unreachable from a remote browser — the deployed app then fails with "bridge/ws error".
# ALWAYS build the deployed dist through this script so the wss bridge URLs, the header/filter
# snapshots and a FRESH mainnet checkpoint (tip-100, fast first sync) are baked in. Single entry
# (index.html) — wallet + market are one app now.
set -euo pipefail
cd "$(dirname "$0")"

# fresh mainnet checkpoint (tip-100) from the filter node, so new wallets fast-sync
MD=/root/fw-mainnet-filter
RPC=$( (grep -oE 'rpcport=[0-9]+' /etc/systemd/system/freicoind-filter.service 2>/dev/null || true) | head -1 | cut -d= -f2)
RPC=${RPC:-18951}
if H=$(curl -fs --user "$(cat $MD/.cookie)" -d '{"method":"getblockcount"}' "http://127.0.0.1:$RPC/" 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"])' 2>/dev/null); then
  CPH=$((H-100))
  HASH=$(curl -fs --user "$(cat $MD/.cookie)" -d "{\"method\":\"getblockhash\",\"params\":[$CPH]}" "http://127.0.0.1:$RPC/" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"])')
  CP="$CPH:$HASH"
  CPDH=$((H-5000))
  DHASH=$(curl -fs --user "$(cat $MD/.cookie)" -d "{\"method\":\"getblockhash\",\"params\":[$CPDH]}" "http://127.0.0.1:$RPC/" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"])')
  CPD="$CPDH:$DHASH"
  echo "checkpoint $CP deep $CPD"
else
  CP=""; CPD=""; echo "WARNING: mainnet node unreachable — building WITHOUT a fresh checkpoint (slower first sync, still correct)"
fi

# type-check (checkJs) before building — catches shadowing, missing imports, wrong shapes
echo "typecheck…"; npx tsc -p jsconfig.json

VITE_BRIDGE=wss://freicoin.ru/ws/regtest \
VITE_BRIDGE_NV3=wss://freicoin.ru/ws/nv3 \
VITE_BRIDGE_MAIN=wss://freicoin.ru/ws/main \
VITE_BRIDGE_TEST=wss://freicoin.ru/ws/test \
VITE_SNAP_MAIN=https://freicoin.ru/snap/main-headers.bin \
VITE_SNAP_MAIN_FILTERS=https://freicoin.ru/snap/main-filters.bin \
VITE_CHECKPOINT_MAIN="$CP" \
VITE_CHECKPOINT_MAIN_DEEP="$CPD" \
npx vite build

echo "built dist/ — bridge=wss://freicoin.ru/ws/*  checkpoint=${CP:-none}"
