> **STATUS (2026-07-14): these are OUR rebase-port bugs**, already fixed in our tree (see miner.patch). This file is now the commit-message draft, not an upstream report. The "related question" at the bottom (witness commitment on signet without FINALTX) is the one genuinely-upstream item — worth asking upstream separately.

# contrib/signet/miner: generate is broken (4 issues) — patch attached

## Summary

`contrib/signet/miner generate` cannot produce a valid block on rebase-31. Four independent
issues, found while bringing up a custom (OP_TRUE-challenge) signet; patch attached
(`miner.patch`), tested end-to-end on a private signet — blocks accepted by freicoind.

## Issues

1. **NameError: `MAX_SEQUENCE_NONFINAL` is not defined.**
   `generate_pst()` uses the constant but it is never imported from
   `test_framework.messages`. First run of `generate` crashes immediately.

2. **NameError: `signme` is not defined.**
   `generate_pst()` builds the PST from `signme`/`spendme`, but the
   `signme, spendme = signet_txs(block, signet_spk_bin)` call was lost in the port
   (`signet_txs()` itself is present and correct).

3. **Rejected: `bad-cb-lock-height`.**
   The coinbase is built without setting `lock_height`. Freicoin consensus requires
   the coinbase `lock_height` to equal the block height (validation.cpp: "coinbase
   lock_height != block height"). Fix: `cbtx.lock_height = tmpl["height"]`.

4. **Rejected: `bad-witness-branch-size`.**
   The port kept Bitcoin's convention of putting `ser_uint256(nonce)` (32 zero bytes)
   in the coinbase input witness. In Freicoin the coinbase witness stack item is the
   **fast-merkle branch** of the commitment: with `witness_nonce = 0` the path byte is
   0x01 → depth 0 → the branch must be **empty** (`stack = [b""]`), or CheckWitnessMalleation
   rejects the block (`ds.size() != 32*witnessdepth`).

Bonus: `trivial_challenge()` is defined but never called. For script-only challenges
(OP_TRUE etc.) `walletprocesspst` cannot produce a "complete" PST, so `generate` dies in
the signing step even though signet.cpp explicitly allows omitting the signet commitment
for such challenges ("no signet solution -- allow this to support OP_TRUE as trivial block
challenge"). The patch wires it up: when `trivial_challenge(tmpl["signet_challenge"])`,
skip wallet signing and call `finish_block(block, None, grind_cmd)` directly.

## Repro

Any custom signet, e.g. `signetchallenge=51`, then:

```
miner --cli="freicoin-cli -signet" generate --min-nbits --address <addr> \
      --grind-cmd='freicoin-util grind'
```

Fails at issue 1; fixing each issue in turn surfaces the next.

## Related question (not part of the patch)

With `DEPLOYMENT_FINALTX` set to `NEVER_ACTIVE` on signet, the witness commitment can only
live in the coinbase of a **single-tx block** (consensus reads it from the tail of the LAST
transaction). A signet block that contains any user transaction has no place for the
commitment, so blocks with witness txs appear impossible to construct. Is that intended,
and if so, how is the public freicoin signet mining witness transactions?
