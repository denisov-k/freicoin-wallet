#!/usr/bin/env python3
"""Phase-2 prototype: routed HTLC and cross-chain atomic swap on Freicoin regtest.

Part A (single chain): a routed payment Alice -> Bob -> Carol across two
channels sharing one payment hash. Bob cannot steal: he only learns the
preimage when Carol claims, and the same preimage lets him claim from Alice.
Each hop uses its own funding epoch R0, so per-hop amounts are denominated
independently -- the routing node absorbs the (sub-kria) epoch-conversion
difference into its fee.

Part B (two chains): an atomic swap of FRC for "OTHER" (a second regtest
node standing in for any SHA256d+CLTV chain, e.g. bitcoin). One hash secret
locks both legs; revealing it to claim one leg exposes it for the other.
Timeouts are staggered so the party who moves second cannot be cheated.

Node 0 = the FRC chain. Node 1 = the OTHER chain.
"""

from test_framework.test_framework import FreicoinTestFramework
from test_framework.util import assert_equal, assert_raises_rpc_error
from test_framework.wallet import MiniWallet
from test_framework.messages import (
    CTransaction, CTxIn, CTxOut, CTxInWitness, COutPoint, sha256,
)
from test_framework.script import (
    CScript, CScriptNum,
    OP_IF, OP_ELSE, OP_ENDIF, OP_CHECKSIG,
    OP_CHECKLOCKTIMEVERIFY, OP_SHA256, OP_EQUALVERIFY, OP_TRUE,
    SegwitV0SignatureHash, SIGHASH_ALL,
)
from test_framework.script_util import script_to_p2wsh_script, script_to_witness
from test_framework.key import ECKey

FEE = 10000


def tx_lock_height(node, txid):
    d = node.getrawtransaction(txid, True)
    for key in ("lock_height", "lockheight", "refheight"):
        if key in d:
            return d[key]
    raise KeyError(sorted(d.keys()))


def htlc_leaf(payment_hash, pub_claim, pub_refund, cltv_height):
    # claim branch: reveal preimage + claimant sig ; refund branch: after CLTV.
    # CLTV consumes its argument on Freicoin (no OP_DROP).
    return CScript([
        OP_IF, OP_SHA256, payment_hash, OP_EQUALVERIFY, pub_claim,
        OP_ELSE, CScriptNum(cltv_height), OP_CHECKLOCKTIMEVERIFY, pub_refund,
        OP_ENDIF, OP_CHECKSIG,
    ])


class LNPhase2(FreicoinTestFramework):
    def set_test_params(self):
        self.num_nodes = 2
        self.setup_clean_chain = True
        self.extra_args = [["-txindex"], ["-txindex"]]

    def setup_network(self):
        # Two INDEPENDENT chains: start both nodes but do not connect them,
        # so node0 (FRC) and node1 (OTHER) never share blocks.
        self.setup_nodes()

    def gen(self, wallet, n):
        # Mine without cross-node syncing (the chains are independent).
        return self.generate(wallet, n, sync_fun=self.no_op)

    # --- helpers parameterized by node/wallet (works on either chain) ---
    def fund_htlc(self, node, wallet, leaf, amount):
        spk = script_to_p2wsh_script(leaf)
        res = wallet.send_to(from_node=node, scriptPubKey=spk, amount=amount)
        txid, vout = res["txid"], res["sent_vout"]
        r0 = tx_lock_height(node, txid)
        self.gen(wallet, 1)
        return COutPoint(int(txid, 16), vout), amount, r0

    def build_spend(self, outpoint, value, r0, leaf, args_builder,
                    nlocktime=0, sequence=0xfffffffd):
        tx = CTransaction()
        tx.version = 2
        tx.lock_height = r0
        tx.nLockTime = nlocktime
        tx.vin = [CTxIn(outpoint, b'', sequence)]
        tx.vout = [CTxOut(value - FEE, script_to_p2wsh_script(CScript([OP_TRUE])))]
        tx.wit.vtxinwit = [CTxInWitness()]
        sighash = SegwitV0SignatureHash(leaf, tx, 0, SIGHASH_ALL, value, r0)
        tx.wit.vtxinwit[0].scriptWitness.stack = args_builder(sighash) + [script_to_witness(leaf), b'']
        tx.rehash()
        return tx

    def sig(self, key, sighash):
        return key.sign_ecdsa(sighash) + bytes([SIGHASH_ALL])

    def confirm(self, node, wallet, tx, label):
        node.sendrawtransaction(tx.serialize().hex())
        self.gen(wallet, 1)
        assert node.getrawtransaction(tx.hash, True)["confirmations"] >= 1
        self.log.info(f"  {label}: CONFIRMED")

    def run_test(self):
        frc, other = self.nodes[0], self.nodes[1]
        w_frc, w_other = MiniWallet(frc), MiniWallet(other)
        self.gen(w_frc, 120)
        self.gen(w_other, 120)

        # keys: A=Alice, B=Bob(router), C=Carol
        keys = {n: ECKey() for n in "ABC"}
        for k in keys.values():
            k.generate()
        pub = {n: keys[n].get_pubkey().get_bytes() for n in keys}

        # =============== Part A: routed HTLC A -> B -> C ===============
        self.log.info("Part A: routed HTLC Alice -> Bob -> Carol (single chain)")
        preimage = b'phase2-routed-htlc-preimage-32by'
        assert_equal(len(preimage), 32)
        H = sha256(preimage)

        # Hop 2 (Bob -> Carol): shorter timeout, so Bob can still refund on hop1
        # after Carol's hop resolves. Standard LN CLTV-delta ordering.
        h2_cltv = frc.getblockcount() + 20
        leaf_bc = htlc_leaf(H, pub["C"], pub["B"], h2_cltv)
        op_bc, val_bc, r0_bc = self.fund_htlc(frc, w_frc, leaf_bc, 3_000_000)
        self.log.info(f"  hop Bob->Carol funded at R0={r0_bc}, cltv={h2_cltv}")

        # Hop 1 (Alice -> Bob): longer timeout.
        h1_cltv = frc.getblockcount() + 40
        leaf_ab = htlc_leaf(H, pub["B"], pub["A"], h1_cltv)
        op_ab, val_ab, r0_ab = self.fund_htlc(frc, w_frc, leaf_ab, 3_050_000)  # +routing fee
        self.log.info(f"  hop Alice->Bob funded at R0={r0_ab}, cltv={h1_cltv}")

        # Carol claims hop2 with the preimage, revealing it on-chain.
        carol_claim = self.build_spend(op_bc, val_bc, r0_bc, leaf_bc,
            lambda sh: [self.sig(keys["C"], sh), preimage, b'\x01'])
        self.confirm(frc, w_frc, carol_claim, "Carol claims hop2 (preimage revealed)")

        # Bob extracts the preimage from Carol's witness and claims hop1.
        claim_tx = frc.getrawtransaction(carol_claim.hash, True)
        witness_items = claim_tx["vin"][0]["txinwitness"]
        revealed = None
        for item in witness_items:
            if item == H.hex() or (len(item) == 64 and sha256(bytes.fromhex(item)) == H):
                revealed = bytes.fromhex(item)
                break
        assert revealed == preimage, "Bob must recover preimage from Carol's claim"
        self.log.info("  Bob recovered preimage from Carol's on-chain witness")
        bob_claim = self.build_spend(op_ab, val_ab, r0_ab, leaf_ab,
            lambda sh: [self.sig(keys["B"], sh), revealed, b'\x01'])
        self.confirm(frc, w_frc, bob_claim, "Bob claims hop1 with recovered preimage")
        self.log.info("  routing complete: same preimage settled both hops atomically")

        # =============== Part B: cross-chain atomic swap ===============
        self.log.info("Part B: atomic swap  FRC (node0)  <->  OTHER (node1)")
        # Alice has FRC, Carol has OTHER. Alice wants OTHER, Carol wants FRC.
        secret = b'phase2-cross-chain-swap-secret32'
        assert_equal(len(secret), 32)
        Hs = sha256(secret)

        # Alice locks FRC, refund after a LONG timeout (she moves first, so she
        # must wait longest before reclaiming).
        frc_cltv = frc.getblockcount() + 40
        leaf_frc = htlc_leaf(Hs, pub["C"], pub["A"], frc_cltv)  # Carol claims, Alice refunds
        op_f, val_f, r0_f = self.fund_htlc(frc, w_frc, leaf_frc, 4_000_000)
        self.log.info(f"  Alice locked FRC (Carol can claim w/ secret), refund@{frc_cltv}")

        # Carol locks OTHER, refund after a SHORTER timeout.
        oth_cltv = other.getblockcount() + 20
        leaf_oth = htlc_leaf(Hs, pub["A"], pub["C"], oth_cltv)  # Alice claims, Carol refunds
        op_o, val_o, r0_o = self.fund_htlc(other, w_other, leaf_oth, 4_000_000)
        self.log.info(f"  Carol locked OTHER (Alice can claim w/ secret), refund@{oth_cltv}")

        # Alice claims OTHER using her secret -> reveals it on the OTHER chain.
        alice_gets_other = self.build_spend(op_o, val_o, r0_o, leaf_oth,
            lambda sh: [self.sig(keys["A"], sh), secret, b'\x01'])
        self.confirm(other, w_other, alice_gets_other, "Alice claims OTHER (secret revealed)")

        # Carol reads the secret from the OTHER chain and claims FRC.
        swap_tx = other.getrawtransaction(alice_gets_other.hash, True)
        rec = None
        for item in swap_tx["vin"][0]["txinwitness"]:
            if len(item) == 64 and sha256(bytes.fromhex(item)) == Hs:
                rec = bytes.fromhex(item)
                break
        assert rec == secret
        self.log.info("  Carol recovered the secret from the OTHER chain")
        carol_gets_frc = self.build_spend(op_f, val_f, r0_f, leaf_frc,
            lambda sh: [self.sig(keys["C"], sh), rec, b'\x01'])
        self.confirm(frc, w_frc, carol_gets_frc, "Carol claims FRC with recovered secret")
        self.log.info("  atomic swap complete: both legs settled with one secret")

        # --- negative check: refund path is time-locked until expiry ---
        self.log.info("Part B (safety): a fresh locked leg cannot be refunded early")
        c2 = frc.getblockcount() + 30
        leaf_x = htlc_leaf(Hs, pub["C"], pub["A"], c2)
        op_x, val_x, r0_x = self.fund_htlc(frc, w_frc, leaf_x, 1_000_000)
        early_refund = self.build_spend(op_x, val_x, r0_x, leaf_x,
            lambda sh: [self.sig(keys["A"], sh), b''],
            nlocktime=c2, sequence=0xfffffffe)
        assert_raises_rpc_error(-26, "non-final",
                                frc.sendrawtransaction, early_refund.serialize().hex())
        self.log.info("  premature refund correctly rejected (non-final)")

        self.log.info("PHASE 2 COMPLETE: routed HTLC and cross-chain atomic swap both "
                      "work on Freicoin; demurrage never required renegotiation.")


if __name__ == '__main__':
    LNPhase2(__file__).main()
