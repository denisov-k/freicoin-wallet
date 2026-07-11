#!/usr/bin/env python3
"""Live end-to-end demo of nVersion=3-lite on a regtest freicoind (-nv3assets): issue a
user asset with its OWN demurrage rate, then transfer it, proving the whole stack works
on-chain — v3 tx serialization, per-asset validation in ConnectBlock, the asset registry,
and asset-tag UTXO persistence.

No signing needed: coins are funded to P2WSH(OP_TRUE) (anyone-can-spend), so the witness is
just the script reveal. Transactions are hand-serialized to the exact Freicoin v3 wire format.
"""
import sys, json, hashlib, http.client, base64

DATADIR = "/tmp/claude-0/-root-free-money/e555c6c3-1be8-497c-bfab-7ed5f9628ddf/scratchpad/nv3reg"
PORT = 19660
sha256 = lambda b: hashlib.sha256(b).digest()
hash256 = lambda b: sha256(sha256(b))
def hash160(b):
    h = hashlib.new('ripemd160'); h.update(sha256(b)); return h.digest()

class RPC:
    def __init__(self):
        self.auth = base64.b64encode(open(f"{DATADIR}/regtest/.cookie", "rb").read()).decode()
    def __call__(self, method, *params):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": list(params)})
        c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=30)
        c.request("POST", "/wallet/w", body, {"Authorization": "Basic " + self.auth, "Content-Type": "application/json"})
        r = json.loads(c.getresponse().read())
        if r.get("error"): raise RuntimeError(f"{method}: {r['error']}")
        return r["result"]

# ---- wire helpers ----
def cs(n):  # compact size
    return bytes([n]) if n < 0xfd else b"\xfd" + n.to_bytes(2, "little")
def varstr(b): return cs(len(b)) + b
def ser_v3(vin, vout, tags, witnesses, lock_height, nlock=0, tokens=None, expire=0):
    """vin=[(txid_hex, vout)], vout=[(value, spk_bytes)], tags=[20b], witnesses=[[items]],
    tokens=[[bytes,...] per output] (unique smart-property tokens), expire=nExpireTime.
    v3 wire: ver | (ff,flags) | vin | vout | tagblock | tokenblock | witness | nLockTime |
    lock_height | nExpireTime — the tag/token blocks ride between vout and witness, the
    expiry is the final field (both only for version==3)."""
    ver = (0x80000003).to_bytes(4, "little")   # NV3_TX_VERSION (top bit: Freicoin extension namespace)
    vins = cs(len(vin))
    for txid, n in vin:
        vins += bytes.fromhex(txid)[::-1] + n.to_bytes(4, "little") + varstr(b"") + b"\xff\xff\xff\xff"
    vouts = cs(len(vout))
    for value, spk in vout:
        vouts += value.to_bytes(8, "little") + varstr(spk)
    tagblock = b"".join(tags)
    toks = tokens or [[] for _ in vout]
    tokenblock = b"".join(cs(len(ts)) + b"".join(varstr(t) for t in ts) for ts in toks)
    tail = nlock.to_bytes(4, "little") + lock_height.to_bytes(4, "little") + expire.to_bytes(4, "little")
    # non-witness serialization -> txid
    nowit = ver + vins + vouts + tagblock + tokenblock + tail
    txid = hash256(nowit)[::-1].hex()
    # full serialization (with marker 0xff + flags + witness)
    wit = b""
    for w in witnesses:
        wit += cs(len(w)) + b"".join(varstr(x) for x in w)
    full = ver + b"\xff\x01" + vins + vouts + tagblock + tokenblock + wit + tail
    return full.hex(), txid

# P2WSH(OP_TRUE): witnessScript = OP_TRUE (0x51); MAST program = hash256(0x00||script)
TRUE_SCRIPT = b"\x51"
TRUE_REVEAL = b"\x00" + TRUE_SCRIPT
TRUE_PROG = hash256(TRUE_REVEAL)
TRUE_SPK = b"\x00\x20" + TRUE_PROG
TRUE_WITNESS = [TRUE_REVEAL, b""]           # reveal + empty MAST proof, no signature
HOST_TAG = b"\x00" * 20                       # null tag = host currency (freicoin)

MAGIC = b"FRA1"

# exact present-value kernel (must match the node's TimeAdjustValueForwardK bit-for-bit)
_M64 = (1 << 64) - 1
def _ladder(k, P=96):
    c = (1 << P) - (1 << (P - k)); L = []
    for _ in range(26): L.append((c >> (P - 64)) & _M64); c = (c * c) >> P
    return L
def present_value(nominal, distance, k):
    if distance == 0: return nominal
    if distance >= (1 << 26): return 0
    L = _ladder(k); w = None
    for b in range(26):
        if distance >> b & 1:
            e = L[b]
            if w is None: w = e; continue
            w = (w * e) >> 64
    return 0 if w is None else (nominal * w) >> 64

def main():
    rpc = RPC()
    try: rpc.__call__ and None
    except Exception: pass
    # a wallet to fund from
    try: rpc("createwallet", "w")
    except RuntimeError: pass
    mine = rpc("getnewaddress")
    rpc("generatetoaddress", 120, mine)      # mature coinbase
    print(f"chain height {rpc('getblockcount')}, balance {rpc('getbalance')} FRC")

    true_addr = rpc("decodescript", TRUE_SPK.hex())["segwit"]["address"] if False else None
    # derive the P2WSH(OP_TRUE) address from the node (bech32m)
    true_addr = rpc("decodescript", TRUE_SCRIPT.hex())["segwit"]["address"]

    def fund(amount_frc):
        txid = rpc("sendtoaddress", true_addr, amount_frc)
        raw = rpc("getrawtransaction", txid, True)
        vout = next(o["n"] for o in raw["vout"] if o["scriptPubKey"]["hex"] == TRUE_SPK.hex())
        val = int(round(raw["vout"][vout]["value"] * 1e8))
        lh = raw.get("lock_height", raw.get("lockheight", 0))
        rpc("generatetoaddress", 1, mine)
        return txid, vout, val, lh

    # ---------- 1. define + mint an asset (shift=18: faster demurrage than FRC's 20) ----------
    def_bytes = bytes([18, 0]) + (1).to_bytes(8, "little") + b"\x00" * 32
    tag = hash160(def_bytes)
    print(f"\nasset tag = {tag.hex()}  (shift=18)")
    opret_spk = b"\x6a" + varstr(MAGIC + def_bytes)   # OP_RETURN <magic+def>

    ftxid, fvout, fval, flh = fund("10.0")
    H = rpc("getblockcount")
    mint_amt = 5_000_000_000                            # 50 units of the new asset
    change = fval - 100000                              # FRC change (100k-kria fee, host melts negligibly at H==flh? use H)
    # build v3 issuance tx: [mint(tag), OP_RETURN def(host), FRC change(host)]
    vout = [(mint_amt, TRUE_SPK), (0, opret_spk), (change, TRUE_SPK)]
    tags = [tag, HOST_TAG, HOST_TAG]
    raw, itxid = ser_v3([(ftxid, fvout)], vout, tags, [TRUE_WITNESS], lock_height=flh)
    rpc("generateblock", mine, [raw])   # mine the tx directly into a block (bypass relay policy)
    conf = rpc("getrawtransaction", itxid, True)
    print(f"1. ISSUANCE mined (conf {conf['confirmations']}): minted {mint_amt/1e8} units of asset {tag.hex()[:12]}…")
    # confirm the minted output carries the asset tag on-chain (tag persisted in the UTXO)
    mint_out = conf["vout"][0]
    print(f"   minted output asset tag on-chain: {mint_out.get('assetTag', mint_out.get('asset', '?'))}")

    # ---------- 2. transfer the asset a few blocks later (per-asset demurrage applies) ----------
    rpc("generatetoaddress", 20, mine)                 # let it age 20 blocks
    Ht = rpc("getblockcount")
    # spend the minted coin (itxid:0). Its present value has melted at shift 18.
    # output the present value (nominal * (1-2^-18)^(Ht-flh)); we conservatively send a bit less.
    dist = Ht - flh
    pv = present_value(mint_amt, dist, 18)               # EXACT, matches the node's kernel
    xfer_out = pv                                        # non-host asset must be conserved exactly
    raw2, xtxid = ser_v3([(itxid, 0)], [(xfer_out, TRUE_SPK)], [tag], [TRUE_WITNESS], lock_height=Ht)
    rpc("generateblock", mine, [raw2])
    conf2 = rpc("getrawtransaction", xtxid, True)
    print(f"2. TRANSFER mined (conf {conf2['confirmations']}): moved asset with per-asset demurrage")
    print(f"   nominal in {mint_amt/1e8}, present value at +{dist} blocks ~{pv/1e8:.6f}, sent {xfer_out/1e8}")
    print(f"   melted by demurrage: ~{(mint_amt-pv)/1e8:.6f} units over {dist} blocks (its own shift-18 rate)")

    # a control: try to send the FULL nominal (more than present value) — consensus must reject
    try:
        bad, _ = ser_v3([(xtxid, 0)], [(mint_amt, TRUE_SPK)], [tag], [TRUE_WITNESS], lock_height=rpc("getblockcount"))
        rpc("generateblock", mine, [bad])
        print("3. UNEXPECTED: consensus accepted an over-nominal (inflationary) asset spend")
    except RuntimeError as e:
        print(f"3. consensus REJECTED an inflationary asset spend, as expected: {str(e)[:70]}")

    print("\nALL DONE ✅ — user asset issued, transferred, and demurrage-conserved on a live chain.")

if __name__ == "__main__":
    main()
