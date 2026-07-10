#!/usr/bin/env python3
"""Phase 3: a REAL cross-chain atomic swap between Freicoin and *actual* Bitcoin Core.

Phase 2 used a second freicoind as a stand-in for "the other chain". This one runs the
BTC leg against a genuine bitcoind regtest, so the two chains differ exactly where they
differ in reality:

  * Freicoin transactions carry lock_height; its SegwitV0 sighash commits refheight and
    lock_height. Bitcoin's BIP143 sighash has neither.
  * Freicoin CLTV CONSUMES its argument (no OP_DROP); Bitcoin CLTV leaves it (needs OP_DROP).
  * Freicoin v0 addresses are bech32m; Bitcoin v0 addresses are bech32.

The swap: Alice holds FRC and wants BTC; Carol holds BTC and wants FRC. One secret R
(H = SHA256(R)) locks both legs. Alice's claim of the BTC leg publishes R on the Bitcoin
chain; Carol reads it there and claims the FRC leg. Atomic across two unrelated chains.

Driven purely over RPC (cookie auth). FRC transactions are built with the freicoin test
framework; BTC transactions are hand-rolled here so nothing freicoin-specific leaks into
the Bitcoin leg — if bitcoind accepts them, they are genuinely Bitcoin-consensus-valid.
"""
import sys, os, json, hashlib, http.client, base64

FRC_TF = "/root/fc31/test/functional"
sys.path.insert(0, FRC_TF)
from test_framework.messages import CTransaction, CTxIn, CTxOut, COutPoint, CTxInWitness
from test_framework.script import (
    CScript, CScriptNum, OP_IF, OP_ELSE, OP_ENDIF, OP_SHA256, OP_EQUALVERIFY,
    OP_CHECKSIG, OP_CHECKLOCKTIMEVERIFY, OP_TRUE, SegwitV0SignatureHash, SIGHASH_ALL,
)
from test_framework.script_util import script_to_p2wsh_script, script_to_witness
from test_framework.key import ECKey

sha256 = lambda b: hashlib.sha256(b).digest()
hash256 = lambda b: sha256(sha256(b))
FEE = 2000  # kria / sats


# ---------------- minimal JSON-RPC over cookie auth ----------------
class RPC:
    def __init__(self, port, cookie, wallet=None):
        self.port, self.wallet = port, wallet
        self.auth = base64.b64encode(open(cookie, "rb").read()).decode()

    def __call__(self, method, *params):
        path = f"/wallet/{self.wallet}" if self.wallet else "/"
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": list(params)})
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        c.request("POST", path, body, {"Authorization": "Basic " + self.auth, "Content-Type": "application/json"})
        r = json.loads(c.getresponse().read())
        if r.get("error"):
            raise RuntimeError(f"{method}: {r['error']}")
        return r["result"]


# ---------------- HTLC witness scripts ----------------
def frc_htlc(H, pub_claim, pub_refund, cltv):
    # Freicoin: CLTV consumes its argument, so NO OP_DROP.
    return CScript([OP_IF, OP_SHA256, H, OP_EQUALVERIFY, pub_claim,
                    OP_ELSE, CScriptNum(cltv), OP_CHECKLOCKTIMEVERIFY, pub_refund,
                    OP_ENDIF, OP_CHECKSIG])

def btc_htlc(H, pub_claim, pub_refund, cltv):
    # Bitcoin: CLTV leaves its argument on the stack, so OP_DROP is REQUIRED.
    from test_framework.script import OP_DROP
    return CScript([OP_IF, OP_SHA256, H, OP_EQUALVERIFY, pub_claim,
                    OP_ELSE, CScriptNum(cltv), OP_CHECKLOCKTIMEVERIFY, OP_DROP, pub_refund,
                    OP_ENDIF, OP_CHECKSIG])


# ---------------- funding (works on either chain via the node wallet) ----------------
def fund(rpc, script_hex, amount_coins):
    # decodescript.segwit.hex is each chain's own P2WSH scriptPubKey (Freicoin uses a MAST
    # long-hash, Bitcoin plain sha256 — let the node tell us rather than assume).
    seg = rpc("decodescript", script_hex)["segwit"]
    addr, spk = seg["address"], seg["hex"]
    txid = rpc("sendtoaddress", addr, amount_coins)
    raw = rpc("getrawtransaction", txid, True)
    vout = next(o["n"] for o in raw["vout"] if o["scriptPubKey"]["hex"] == spk)
    val = int(round(raw["vout"][vout]["value"] * 1e8))
    return txid, vout, val, raw.get("lock_height", raw.get("lockheight", 0))


# ---------------- FRC spend (freicoin serialization + refheight sighash) ----------------
def frc_spend(outpoint, value, r0, leaf, witness_args):
    tx = CTransaction()
    tx.version = 2
    tx.lock_height = r0
    tx.vin = [CTxIn(outpoint, b"", 0xfffffffd)]
    tx.vout = [CTxOut(value - FEE, script_to_p2wsh_script(CScript([OP_TRUE])))]
    tx.wit.vtxinwit = [CTxInWitness()]
    sh = SegwitV0SignatureHash(leaf, tx, 0, SIGHASH_ALL, value, r0)
    tx.wit.vtxinwit[0].scriptWitness.stack = witness_args(sh) + [script_to_witness(leaf), b""]
    tx.rehash()
    return tx.serialize().hex(), tx.hash


# ---------------- BTC spend (hand-rolled: standard BIP143, no lock_height) ----------------
def _cs(i):  # compact size
    return bytes([i]) if i < 0xfd else b"\xfd" + i.to_bytes(2, "little")

def _pushdata(b):
    return _cs(len(b)) + b

def btc_spend(txid, vout, value, leaf, out_spk, witness_args, nlocktime=0, sequence=0xffffffff):
    op = bytes.fromhex(txid)[::-1] + vout.to_bytes(4, "little")
    out = (value - FEE).to_bytes(8, "little") + _pushdata(out_spk)
    # BIP143 sighash (no refheight, no lock_height — genuine Bitcoin)
    hp = hash256(op)
    hs = hash256(sequence.to_bytes(4, "little"))
    ho = hash256(out)
    pre = (b"\x02\x00\x00\x00" + hp + hs + op + _pushdata(bytes(leaf))
           + value.to_bytes(8, "little") + sequence.to_bytes(4, "little")
           + ho + nlocktime.to_bytes(4, "little") + b"\x01\x00\x00\x00")
    sighash = hash256(pre)
    stack = witness_args(sighash) + [bytes(leaf)]
    wit = _cs(len(stack)) + b"".join(_pushdata(x) for x in stack)
    # non-witness serialization for txid; full serialization (marker/flag+witness) to send
    base = b"\x02\x00\x00\x00" + _cs(1) + op + b"\x00" + sequence.to_bytes(4, "little") \
           + _cs(1) + out + nlocktime.to_bytes(4, "little")
    full = (b"\x02\x00\x00\x00" + b"\x00\x01" + _cs(1) + op + b"\x00" + sequence.to_bytes(4, "little")
            + _cs(1) + out + wit + nlocktime.to_bytes(4, "little"))
    return full.hex(), hash256(base)[::-1].hex()


def main():
    SC = "/tmp/claude-0/-root-free-money/e555c6c3-1be8-497c-bfab-7ed5f9628ddf/scratchpad"
    frc = RPC(19560, "/root/fw-bdev/regtest/.cookie", "swap")
    btc = RPC(19332, f"{SC}/btc-data/regtest/.cookie", "swap")
    frc_addr = frc("getnewaddress")
    btc_addr = btc("getnewaddress")
    frc_mine = lambda n=1: frc("generatetoaddress", n, frc_addr)
    btc_mine = lambda n=1: btc("generatetoaddress", n, btc_addr)

    # keys (secp256k1 ECDSA — identical on both chains)
    kA, kC = ECKey(), ECKey()            # Alice (wants BTC), Carol (wants FRC)
    kAr, kCr = ECKey(), ECKey()          # refund keys
    for k in (kA, kC, kAr, kCr):
        k.generate()
    pA = kA.get_pubkey().get_bytes(); pC = kC.get_pubkey().get_bytes()
    pAr = kAr.get_pubkey().get_bytes(); pCr = kCr.get_pubkey().get_bytes()

    secret = b"phase3-real-bitcoin-swap-secret!"
    assert len(secret) == 32
    H = sha256(secret)
    ok = True

    print("== cross-chain atomic swap: Freicoin  <->  REAL Bitcoin Core ==")
    print(f"   BTC node: {btc('getblockchaininfo')['blocks']} blocks | FRC node: {frc('getblockchaininfo')['blocks']} blocks")

    # 1. Alice locks FRC. Carol claims with secret; Alice refunds after the LONGER timeout.
    frc_cltv = frc("getblockcount") + 40
    leaf_frc = frc_htlc(H, pC, pAr, frc_cltv)          # Carol claims, Alice refunds
    ftxid, fvout, fval, fr0 = fund(frc, bytes(leaf_frc).hex(), "10.0")
    frc_mine()
    print(f"1. Alice locked 10 FRC (Carol claims w/ secret), refund@{frc_cltv}, lock_height={fr0}")

    # 2. Carol locks BTC. Alice claims with secret; Carol refunds after the SHORTER timeout.
    btc_cltv = btc("getblockcount") + 20
    leaf_btc = btc_htlc(H, pA, pCr, btc_cltv)          # Alice claims, Carol refunds
    btxid, bvout, bval, _ = fund(btc, bytes(leaf_btc).hex(), "0.20")
    btc_mine()
    print(f"2. Carol locked 0.20 BTC (Alice claims w/ secret), refund@{btc_cltv}  [BTC HTLC accepted by bitcoind]")

    # 3. Alice claims the BTC using the secret -> secret becomes public on the Bitcoin chain.
    out_spk = bytes.fromhex(btc("getaddressinfo", btc_addr)["scriptPubKey"])
    braw, bhash = btc_spend(btxid, bvout, bval, leaf_btc, out_spk,
                            lambda sh: [kA.sign_ecdsa(sh) + b"\x01", secret, b"\x01"])
    sent = btc("sendrawtransaction", braw)
    btc_mine()
    conf = btc("getrawtransaction", sent, True)["confirmations"]
    print(f"3. Alice claimed BTC with the secret (bitcoind confirmed, {conf} conf) -> secret now on the BTC chain")

    # 4. Carol reads the secret from the Bitcoin chain's witness and claims the FRC.
    wit = btc("getrawtransaction", sent, True)["vin"][0]["txinwitness"]
    revealed = next((bytes.fromhex(x) for x in wit if len(x) == 64 and sha256(bytes.fromhex(x)) == H), None)
    assert revealed == secret, "Carol must recover the secret from Bitcoin's chain"
    print("4. Carol recovered the secret from the Bitcoin chain")
    fraw, fh = frc_spend(COutPoint(int(ftxid, 16), fvout), fval, fr0, leaf_frc,
                         lambda sh: [kC.sign_ecdsa(sh) + b"\x01", secret, b"\x01"])
    frc("sendrawtransaction", fraw)
    frc_mine()
    # verify via the UTXO set (the FRC node has no -txindex): the HTLC output is now spent.
    frc_spent = frc("gettxout", ftxid, fvout) is None
    print(f"5. Carol claimed the FRC with the same secret (HTLC output spent: {frc_spent})")

    # ---- the "gotcha" proof: the OP_DROP difference bites on the REFUND (CLTV) branch ----
    # On the claim (preimage) branch the two scripts are identical, so that path can't show
    # it. The CLTV argument only lingers on the refund branch — exactly where a careless
    # Bitcoin port of the Freicoin script (which omits OP_DROP) would break.
    print("\n== control: exercise the CLTV refund branch on Bitcoin, good vs OP_DROP-less ==")
    refund_wit = lambda sh: [kCr.sign_ecdsa(sh) + b"\x01", b""]     # false -> ELSE (refund)
    def try_refund(leaf, label):
        c = btc("getblockcount") + 5
        leaf_c = leaf(H, pA, pCr, c)
        tx, v, val, _ = fund(btc, bytes(leaf_c).hex(), "0.05"); btc_mine(6)   # advance past CLTV
        raw, _ = btc_spend(tx, v, val, leaf_c, out_spk, refund_wit, nlocktime=c, sequence=0xfffffffe)
        try:
            btc("sendrawtransaction", raw); return True
        except RuntimeError as e:
            return str(e).split("message':")[-1][:70]
    good = try_refund(btc_htlc, "with OP_DROP")
    bad = try_refund(frc_htlc, "without OP_DROP (Freicoin-style)")
    print(f"   refund with OP_DROP (correct Bitcoin HTLC): {'ACCEPTED ✓' if good is True else 'rejected: '+str(good)}")
    print(f"   refund without OP_DROP (Freicoin script):   {'ACCEPTED (gotcha absent!)' if bad is True else 'REJECTED ✓ ->'+str(bad)}")
    gotcha = (good is True) and (bad is not True)

    print("\n" + ("ALL PASS ✅  real FRC<->BTC atomic swap settled end-to-end; refund path works; "
                  "the CLTV-consume gotcha is confirmed real."
                  if revealed == secret and frc_spent and conf >= 1 and gotcha else "FAILED ❌"))
    return 0 if (revealed == secret and frc_spent and conf >= 1 and gotcha) else 1


if __name__ == "__main__":
    sys.exit(main())
