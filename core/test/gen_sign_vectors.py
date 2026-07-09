#!/usr/bin/env python3
# Golden ECDSA vectors from Freicoin's key.py (deterministic rfc6979=True). NO node.
# Usage: python3 gen_sign_vectors.py > sign_vectors.json
import sys, json, random
sys.path.insert(0, '/root/fc31/test/functional')
from test_framework.key import ECKey

rng = random.Random(2024)
cases = []
for _ in range(40):
    secret = rng.getrandbits(256) % (0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - 1) + 1
    sb = secret.to_bytes(32, 'big')
    key = ECKey(); key.set(sb, True)
    msg = rng.getrandbits(256).to_bytes(32, 'big')
    sig = key.sign_ecdsa(msg, low_s=True, rfc6979=True)   # deterministic
    cases.append({
        "secret": sb.hex(),
        "pubkey": key.get_pubkey().get_bytes().hex(),
        "msg": msg.hex(),
        "der": sig.hex(),
    })
print(json.dumps(cases))
