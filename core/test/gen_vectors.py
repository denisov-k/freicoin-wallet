#!/usr/bin/env python3
# Generate golden demurrage vectors from the consensus-bit-exact python reference.
# Usage: python3 gen_vectors.py > vectors.json   (needs rebase-31 test_framework on path)
import sys, json, random
sys.path.insert(0, '/root/fc31/test/functional')
from test_framework.wallet import time_adjust_value_forward as taf
COIN = 100000000
fixed = [(0,0),(COIN,0),(COIN,1),(COIN,144),(COIN,52560),(50*COIN,100),
         (-COIN,144),(1,1000000),(COIN,(1<<26)-1),(COIN,(1<<26)),(99999432*COIN,10)]
rng = random.Random(42)
rnd = [(rng.randint(-10**15,10**15), rng.randint(0,(1<<26)+5)) for _ in range(200)]
print(json.dumps([{"v":str(v),"d":d,"e":str(taf(v,d))} for v,d in fixed+rnd]))
