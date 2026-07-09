#!/usr/bin/env python3
# Golden Freicoin SegwitV0 sighash vectors from the reference implementation.
# NO node needed. Usage: python3 gen_sighash_vectors.py > sighash_vectors.json
import sys, json, random
sys.path.insert(0, '/root/fc31/test/functional')
from test_framework.messages import CTransaction, CTxIn, CTxOut, COutPoint
from test_framework.script import (
    CScript, SegwitV0SignatureMsg, SegwitV0SignatureHash,
    SIGHASH_ALL, SIGHASH_NONE, SIGHASH_SINGLE, SIGHASH_ANYONECANPAY, SIGHASH_NO_LOCK_HEIGHT,
    OP_DUP, OP_HASH160, OP_EQUALVERIFY, OP_CHECKSIG,
)

COIN = 100000000
rng = random.Random(7)

def rand_tx(n_in, n_out, lock_height):
    tx = CTransaction()
    tx.version = 2
    tx.nLockTime = rng.randint(0, 500000)
    tx.lock_height = lock_height
    for k in range(n_in):
        h = rng.getrandbits(256)
        tx.vin.append(CTxIn(COutPoint(h, k), nSequence=rng.randint(0, 0xffffffff)))
    for k in range(n_out):
        spk = CScript([OP_DUP, OP_HASH160, bytes([k]) * 20, OP_EQUALVERIFY, OP_CHECKSIG])
        tx.vout.append(CTxOut(rng.randint(1, 100 * COIN), spk))
    return tx

def script_code(keyhash):  # the implicit P2PKH scriptCode for a wpk spend
    return CScript([OP_DUP, OP_HASH160, keyhash, OP_EQUALVERIFY, OP_CHECKSIG])

hashtypes = [
    SIGHASH_ALL, SIGHASH_NONE, SIGHASH_SINGLE,
    SIGHASH_ALL | SIGHASH_ANYONECANPAY,
    SIGHASH_SINGLE | SIGHASH_ANYONECANPAY,
    SIGHASH_ALL | SIGHASH_NO_LOCK_HEIGHT,
    SIGHASH_NONE | SIGHASH_ANYONECANPAY | SIGHASH_NO_LOCK_HEIGHT,
]

cases = []
for _ in range(60):
    n_in = rng.randint(1, 5)
    n_out = rng.randint(1, 5)
    lh = rng.randint(0, 300000)
    tx = rand_tx(n_in, n_out, lh)
    in_idx = rng.randint(0, n_in - 1)
    ht = rng.choice(hashtypes)
    amount = rng.randint(1, 100 * COIN)
    refheight = rng.randint(0, lh)                 # refheight <= lock_height
    sc = script_code(bytes([rng.randint(0, 255)]) * 20)
    preimage = SegwitV0SignatureMsg(sc, tx, in_idx, ht, amount, refheight)
    sh = SegwitV0SignatureHash(sc, tx, in_idx, ht, amount, refheight)
    # tx fields JS needs (mirrors tx.mjs parse output)
    cases.append({
        "tx": {
            "version": tx.version, "nLockTime": tx.nLockTime, "lockHeight": tx.lock_height,
            "vin": [{"prevout": {"txid": i.prevout.serialize()[:32].hex(),
                                 "vout": i.prevout.n}, "sequence": i.nSequence} for i in tx.vin],
            "vout": [{"value": str(o.nValue), "scriptPubKey": o.scriptPubKey.hex()} for o in tx.vout],
        },
        "inIdx": in_idx, "scriptCode": sc.hex(), "amount": str(amount),
        "refheight": refheight, "hashtype": ht,
        "preimage": preimage.hex(), "sighash": sh.hex(),
    })
print(json.dumps(cases))
