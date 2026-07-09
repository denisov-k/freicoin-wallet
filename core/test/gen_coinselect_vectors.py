#!/usr/bin/env python3
# Golden vectors for refheight-aware coin valuation, from the consensus-bit-exact
# python reference (time_adjust_value_forward), mirroring test_framework/wallet.py
# create_self_transfer_multi input valuation. NO node needed.
# Usage: python3 gen_coinselect_vectors.py > coinselect_vectors.json
import sys, json, random
sys.path.insert(0, '/root/fc31/test/functional')
from test_framework.wallet import time_adjust_value_forward as taf

rng = random.Random(1234)
COIN = 100000000

def make_case(n):
    # random utxo set: nominal kria + refheight
    utxos = [{"value": rng.randint(1, 100 * COIN), "refheight": rng.randint(0, 200000)}
             for _ in range(n)]
    max_ref = max(u["refheight"] for u in utxos)
    # lock_height >= max refheight (monotonicity), like wallet.py's default
    lockheight = max_ref + rng.randint(0, 50000)
    per_coin_pv = [taf(u["value"], lockheight - u["refheight"]) for u in utxos]
    return {
        "utxos": [{"value": str(u["value"]), "refheight": u["refheight"]} for u in utxos],
        "lockheight": lockheight,
        "per_coin_pv": [str(p) for p in per_coin_pv],
        "inputs_present_value": str(sum(per_coin_pv)),
    }

cases = [make_case(rng.randint(1, 12)) for _ in range(150)]
# a couple of fixed edge cases
cases.append({  # single coin, lock_height == refheight (distance 0 => nominal)
    "utxos": [{"value": str(50 * COIN), "refheight": 100}], "lockheight": 100,
    "per_coin_pv": [str(taf(50 * COIN, 0))], "inputs_present_value": str(taf(50 * COIN, 0))})
cases.append({  # deep decay
    "utxos": [{"value": str(COIN), "refheight": 0}], "lockheight": 52560,
    "per_coin_pv": [str(taf(COIN, 52560))], "inputs_present_value": str(taf(COIN, 52560))})
print(json.dumps(cases))
