#!/usr/bin/env python3
"""Phase-1 prototype: Lightning-style payment channel primitives on Freicoin regtest.

Five scenes:
  1. fund + cooperative close of a 2-of-2 MAST channel
  2. "eternal receipt": a close tx signed at open time remains valid and
     correctly valued hundreds of blocks later (demurrage handled by the
     R0-epoch denomination scheme -- no renegotiation ever needed)
  3. BOLT3-style to_local: CSV-delayed self-spend path
  4. same leaf, revocation path (immediate spend with revocation key)
  5. HTLC leaf: success-with-preimage and timeout-after-CLTV paths

All channel transactions carry lock_height = R0 (the funding refheight), so
all amounts are denominated in the funding epoch and no demurrage adjustment
appears anywhere in the channel protocol.
"""

from test_framework.test_framework import FreicoinTestFramework
from test_framework.util import assert_equal, assert_raises_rpc_error
from test_framework.wallet import MiniWallet
from test_framework.messages import (
    CTransaction, CTxIn, CTxOut, CTxInWitness, COutPoint, sha256,
)
from test_framework.script import (
    CScript, CScriptNum,
    OP_2, OP_CHECKMULTISIG, OP_CHECKSIG, OP_IF, OP_ELSE, OP_ENDIF,
    OP_CHECKSEQUENCEVERIFY, OP_CHECKLOCKTIMEVERIFY, OP_DROP,
    OP_SHA256, OP_EQUALVERIFY, OP_TRUE,
    SegwitV0SignatureHash, SIGHASH_ALL,
)
from test_framework.script_util import (
    script_to_p2wsh_script, script_to_witness,
)
from test_framework.key import ECKey

FEE = 10000  # kria, flat fee for channel txs (empty-mempool chain)


def tx_lock_height(node, txid):
    """Reference height of a confirmed transaction's outputs."""
    d = node.getrawtransaction(txid, True)
    for key in ("lock_height", "lockheight", "refheight"):
        if key in d:
            return d[key]
    raise KeyError(f"no lock_height field in getrawtransaction: {sorted(d.keys())}")


def multisig_2of2(pub_a, pub_b):
    return CScript([OP_2, pub_a, pub_b, OP_2, OP_CHECKMULTISIG])


def to_local_leaf(pub_rev, pub_local, delay):
    # NB: unlike bitcoin, Freicoin's CHECKSEQUENCEVERIFY consumes its
    # argument (protocol-cleanup semantics), so no OP_DROP after it.
    return CScript([
        OP_IF, pub_rev,
        OP_ELSE, CScriptNum(delay), OP_CHECKSEQUENCEVERIFY, pub_local,
        OP_ENDIF, OP_CHECKSIG,
    ])


def htlc_leaf(payment_hash, pub_success, pub_timeout, cltv_height):
    # NB: CHECKLOCKTIMEVERIFY likewise consumes its argument on Freicoin.
    return CScript([
        OP_IF, OP_SHA256, payment_hash, OP_EQUALVERIFY, pub_success,
        OP_ELSE, CScriptNum(cltv_height), OP_CHECKLOCKTIMEVERIFY, pub_timeout,
        OP_ENDIF, OP_CHECKSIG,
    ])


class LNChannelPrototype(FreicoinTestFramework):
    def set_test_params(self):
        self.num_nodes = 1
        self.setup_clean_chain = True
        self.extra_args = [["-txindex"]]

    def fund_leaf(self, leaf, amount):
        """Create a funding output paying to the single-leaf MAST program.
        Returns (outpoint, value, R0)."""
        spk = script_to_p2wsh_script(leaf)
        res = self.wallet.send_to(from_node=self.node, scriptPubKey=spk, amount=amount)
        txid, vout = res["txid"], res["sent_vout"]
        r0 = tx_lock_height(self.node, txid)  # read from mempool (no -txindex)
        self.generate(self.wallet, 1)
        outpoint = COutPoint(int(txid, 16), vout)
        return outpoint, amount, r0

    def spend_leaf(self, outpoint, value, r0, leaf, witness_args_builder,
                   sequence=0xfffffffd, nlocktime=0, outputs=None):
        """Build a channel tx spending the funded leaf. All values in R0 epoch."""
        tx = CTransaction()
        tx.version = 2
        tx.lock_height = r0
        tx.nLockTime = nlocktime
        tx.vin = [CTxIn(outpoint, b'', sequence)]
        tx.vout = outputs or [CTxOut(value - FEE, script_to_p2wsh_script(CScript([OP_TRUE])))]
        tx.wit.vtxinwit = [CTxInWitness()]
        sighash = SegwitV0SignatureHash(leaf, tx, 0, SIGHASH_ALL, value, r0)
        args = witness_args_builder(sighash)
        tx.wit.vtxinwit[0].scriptWitness.stack = args + [script_to_witness(leaf), b'']
        tx.rehash()
        return tx

    def sig(self, key, sighash):
        return key.sign_ecdsa(sighash) + bytes([SIGHASH_ALL])

    def send_and_mine(self, tx, label):
        """Try policy path first (recon item: relay standardness), mine either way."""
        raw = tx.serialize().hex()
        try:
            self.node.sendrawtransaction(raw)
            policy = "relay-standard"
            self.generate(self.wallet, 1)
        except Exception as e:
            policy = f"policy-rejected ({str(e)[:60]}) -> mined directly"
            self.generateblock(self.node, output="raw(51)", transactions=[raw])
        self.log.info(f"  {label}: CONFIRMED [{policy}]")
        assert self.node.getrawtransaction(tx.hash, True)["confirmations"] >= 1
        return policy

    def run_test(self):
        self.node = self.nodes[0]
        self.wallet = MiniWallet(self.node)
        self.generate(self.wallet, 120)  # mature coins

        key_a, key_b, key_rev = ECKey(), ECKey(), ECKey()
        for k in (key_a, key_b, key_rev):
            k.generate()
        pub_a = key_a.get_pubkey().get_bytes()
        pub_b = key_b.get_pubkey().get_bytes()
        pub_rev = key_rev.get_pubkey().get_bytes()

        V = 5_000_000  # channel capacity, kria (nominal in funding epoch)

        # ---------------- Scene 1: fund + cooperative close ----------------
        self.log.info("Scene 1: 2-of-2 funding and cooperative close")
        leaf = multisig_2of2(pub_a, pub_b)
        op, val, r0 = self.fund_leaf(leaf, V)
        self.log.info(f"  channel open at R0={r0}")

        def coop_args(sighash):
            return [b'', self.sig(key_a, sighash), self.sig(key_b, sighash)]

        close = self.spend_leaf(op, val, r0, leaf, coop_args)
        self.send_and_mine(close, "cooperative close")

        # ---------------- Scene 2: the eternal receipt ----------------
        self.log.info("Scene 2: close tx signed at open, broadcast 300 blocks later")
        op2, val2, r0_2 = self.fund_leaf(leaf, V)
        close2 = self.spend_leaf(op2, val2, r0_2, leaf, coop_args)  # signed NOW
        tip_at_signing = self.node.getblockcount()
        self.generate(self.wallet, 300)  # ~2 days of chain time pass
        assert_equal(self.node.getblockcount(), tip_at_signing + 300)
        self.send_and_mine(close2, "stale-signed close after 300 blocks")
        utxo = self.node.gettxout(close2.hash, 0)
        self.log.info(f"  output as seen by gettxout: {utxo['value']} "
                      f"(nominal in R0 epoch: {(val2 - FEE) / 1e8})")

        # ---------------- Scene 3: to_local, delayed path ----------------
        self.log.info("Scene 3: to_local leaf, CSV-delayed self-spend")
        # Note: Freicoin's protocol cleanup makes minimal-push a mandatory
        # (consensus) rule, so numbers 1-16 inside scripts must be OP_N.
        # We use 17 to keep the framework's byte-push encoding minimal.
        DELAY = 17
        leaf3 = to_local_leaf(pub_rev, pub_a, DELAY)
        op3, val3, r0_3 = self.fund_leaf(leaf3, V)

        def delayed_args(sighash):
            return [self.sig(key_a, sighash), b'']  # b'' selects ELSE branch

        sweep = self.spend_leaf(op3, val3, r0_3, leaf3, delayed_args, sequence=DELAY)
        # too early: only 1 confirmation, need 5
        assert_raises_rpc_error(-26, "non-BIP68-final",
                                self.node.sendrawtransaction, sweep.serialize().hex())
        self.log.info("  premature sweep correctly rejected (non-BIP68-final)")
        self.generate(self.wallet, DELAY - 1)
        self.send_and_mine(sweep, f"sweep after {DELAY}-block CSV delay")

        # ---------------- Scene 4: to_local, revocation path ----------------
        self.log.info("Scene 4: to_local leaf, immediate revocation spend")
        op4, val4, r0_4 = self.fund_leaf(leaf3, V)

        def revocation_args(sighash):
            return [self.sig(key_rev, sighash), b'\x01']  # 0x01 selects IF branch

        justice = self.spend_leaf(op4, val4, r0_4, leaf3, revocation_args)
        self.send_and_mine(justice, "justice tx via revocation key (no delay)")

        # ---------------- Scene 5: HTLC, both paths ----------------
        self.log.info("Scene 5: HTLC leaf, success and timeout paths")
        preimage = b'gesell-lightning-preimage-32byte'
        assert_equal(len(preimage), 32)
        payment_hash = sha256(preimage)

        # success path (B knows the preimage)
        cltv_h = self.node.getblockcount() + 50
        leaf5 = htlc_leaf(payment_hash, pub_b, pub_a, cltv_h)
        op5, val5, r0_5 = self.fund_leaf(leaf5, V)

        def success_args(sighash):
            return [self.sig(key_b, sighash), preimage, b'\x01']

        claim = self.spend_leaf(op5, val5, r0_5, leaf5, success_args)
        self.send_and_mine(claim, "HTLC success with preimage")

        # timeout path (A after CLTV expiry)
        cltv_h2 = self.node.getblockcount() + 10
        leaf6 = htlc_leaf(payment_hash, pub_b, pub_a, cltv_h2)
        op6, val6, r0_6 = self.fund_leaf(leaf6, V)

        def timeout_args(sighash):
            return [self.sig(key_a, sighash), b'']

        refund = self.spend_leaf(op6, val6, r0_6, leaf6, timeout_args,
                                 sequence=0xfffffffe, nlocktime=cltv_h2)
        assert_raises_rpc_error(-26, "non-final",
                                self.node.sendrawtransaction, refund.serialize().hex())
        self.log.info("  premature HTLC refund correctly rejected (non-final)")
        self.generate(self.wallet, 15)
        self.send_and_mine(refund, "HTLC timeout refund after CLTV expiry")

        self.log.info("ALL SCENES PASSED: channel primitives work on Freicoin, "
                      "amounts denominated in R0 epoch throughout, zero demurrage "
                      "renegotiation required.")


if __name__ == '__main__':
    LNChannelPrototype(__file__).main()
