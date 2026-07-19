#!/usr/bin/env bash
# verify-build.sh — reproduce the deployed freicoin.ru bundle from source and compare hashes.
#
# Trust model: a web wallet is only as honest as the JavaScript the server hands out. This
# script lets ANYONE prove the served bundle is built from this repository:
#
#   git clone https://github.com/denisov-k/freicoin-wallet && cd freicoin-wallet
#   bash scripts/verify-build.sh            # or: SITE=https://freicoin.ru bash scripts/verify-build.sh
#
# It downloads the live index.html, extracts the asset names and the ONE build-time input that
# legitimately changes between builds (the mainnet fast-sync checkpoint "height:blockhash",
# baked in via VITE_CHECKPOINT_MAIN), rebuilds the app from the checked-out source with npm ci
# (lockfile-pinned dependencies), and byte-compares every produced asset against the served one.
#
# The checkpoint itself is NOT trusted: it is printed at the end so you can verify the block
# hash against any independent Freicoin node/explorer (`freicoin-cli getblockhash <height>`).
# Everything else — all application code — must match bit-for-bit or the script fails.
#
# Requirements: node >= 20, npm, curl. (Vite output is deterministic for a given lockfile.)
set -euo pipefail
cd "$(dirname "$0")/.."

SITE="${SITE:-https://freicoin.ru}"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

echo "== fetching $SITE =="
curl -fsS "$SITE/" -o "$WORK/index.html"
JS=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' "$WORK/index.html" | head -1)
CSS=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.css' "$WORK/index.html" | head -1)
[ -n "$JS" ] && [ -n "$CSS" ] || { echo "FAIL: could not find asset names in index.html"; exit 1; }
curl -fsS "$SITE$JS" -o "$WORK/deployed.js"
echo "deployed entry: $JS  $CSS"

# the only per-build input: the baked mainnet checkpoint (height:hash)
CP=$(grep -oE '[0-9]{6,9}:[0-9a-f]{64}' "$WORK/deployed.js" | head -1 || true)
echo "baked checkpoint: ${CP:-none}"

echo "== building from source (npm ci, lockfile-pinned) =="
( cd apps/web && npm ci --no-audit --no-fund >/dev/null )
( cd apps/web && \
  VITE_BRIDGE=wss://freicoin.ru/ws/regtest \
  VITE_BRIDGE_NV3=wss://freicoin.ru/ws/nv3 \
  VITE_BRIDGE_MAIN=wss://freicoin.ru/ws/main \
  VITE_BRIDGE_TEST=wss://freicoin.ru/ws/test \
  VITE_SNAP_MAIN=https://freicoin.ru/snap/main-headers.bin \
  VITE_SNAP_MAIN_FILTERS=https://freicoin.ru/snap/main-filters.bin \
  VITE_CHECKPOINT_MAIN="$CP" \
  npx vite build >/dev/null )

[ -f "apps/web/dist$JS" ] || { echo "FAIL: local build did not produce $JS (source differs from deployment)"; ls apps/web/dist/assets/; exit 1; }

# compare EVERY produced asset (entry, css, web workers) against the served copy
ok=1
for f in apps/web/dist/assets/*; do
  n=$(basename "$f")
  curl -fsS "$SITE/assets/$n" -o "$WORK/srv" || { echo "MISMATCH $n (not served)"; ok=0; continue; }
  ha=$(sha256sum "$WORK/srv" | cut -d' ' -f1); hb=$(sha256sum "$f" | cut -d' ' -f1)
  if [ "$ha" = "$hb" ]; then echo "OK   $n  sha256=$ha"; else echo "MISMATCH $n"; echo "  deployed: $ha"; echo "  local:    $hb"; ok=0; fi
done

echo
if [ "$ok" = 1 ]; then
  echo "✅ REPRODUCIBLE: the served bundle is byte-identical to this source tree."
  [ -n "$CP" ] && echo "   Now independently verify the checkpoint: block ${CP%%:*} must have hash ${CP#*:}"
else
  echo "❌ NOT REPRODUCIBLE — the served bundle does not match this source tree."; exit 1
fi
