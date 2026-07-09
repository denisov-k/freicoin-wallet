#!/usr/bin/env python3
# Golden PST vectors built with the pure-python Freicoin PST implementation.
# NO node needed. Usage: python3 gen_pst_vectors.py > pst_vectors.json
import sys, json
sys.path.insert(0, '/root/fc31/test/functional')
from test_framework.messages import (
    CTransaction, CTxIn, CTxOut, COutPoint,
)
from test_framework.script import CScript
from test_framework.pst import PST, PSTMap, PST_GLOBAL_UNSIGNED_TX, PST_IN_WITNESS_UTXO

COIN = 100000000

def build_pst(n_in, n_out, lock_height):
    tx = CTransaction()
    tx.version = 2
    tx.nLockTime = 0
    tx.lock_height = lock_height          # Freicoin trailing field
    for k in range(n_in):
        tx.vin.append(CTxIn(COutPoint(0x1111111111111111111111111111111111111111111111111111111111111111 + k, k)))
    for k in range(n_out):
        tx.vout.append(CTxOut((k + 1) * COIN, CScript(b"\x00\x14" + bytes([k]) * 20)))  # p2wpk-ish spk

    g = PSTMap(map={PST_GLOBAL_UNSIGNED_TX: tx.serialize_without_witness()})
    # each input carries a witness_utxo (key 0x01): value(8) + spk
    ins = []
    for k in range(n_in):
        wu = CTxOut((k + 5) * COIN, CScript(b"\x00\x14" + bytes([k + 1]) * 20))
        ins.append(PSTMap(map={PST_IN_WITNESS_UTXO: wu.serialize()}))
    outs = [PSTMap(map={}) for _ in range(n_out)]

    pst = PST(g=g, i=ins, o=outs)
    return pst.serialize()

cases = []
for (ni, no, lh) in [(1, 1, 0), (1, 2, 100), (2, 2, 200000), (3, 1, 52560), (2, 3, 1)]:
    raw = build_pst(ni, no, lh)
    cases.append({
        "n_in": ni, "n_out": no, "lock_height": lh,
        "hex": raw.hex(),
    })
print(json.dumps(cases))
