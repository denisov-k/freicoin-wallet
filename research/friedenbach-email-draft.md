To: mark@friedenbach.org
Subject: Freicoin nVersion=3 assets built on your reserved extension-output field — implementation + a few design questions

Dear Mark,

I've been building on Tradecraft/Freicoin for the past months and opened issue #108 a
little while ago; I realize a GitHub issue is easy to miss, so I hope a direct note is a
better way to reach you. I want to (1) show you what has been built and (2) ask a small
number of design questions where your intent matters more than my guesswork.

I'll keep this concise.

## Context

I've rebased Freicoin onto modern Bitcoin Core (a rebase-29 → 30 → 31 series, currently on
the Core 31.1 base) and, on top of it, implemented an experimental "nVersion=3-lite" asset
layer with a matching light wallet, an order-book relay, and cross-chain BTC↔FRC atomic
swaps. It runs today on a private chain and a public demo.

The asset layer implements, as executable consensus (with a JS reference model mirroring it
1:1 for cross-checking):
- Per-asset issuance with self-certified monetary policy (demurrage OR interest, i.e. the
  host demurrage kernel generalized per asset; melting, constant, and growing assets all
  settle in present value at the tx's lock_height).
- Per-asset conservation in present value; granularity; unique indivisible tokens (smart
  property); optional per-asset authorizer signatures (KYC/restricted-stock style),
  carried witness-side so they stay outside the txid.
- A DEX: composite (multi-maker bundle) transactions and ranged partial-fill offers, with
  SIGHASH_BUNDLE-style digests that let a matcher splice offers without invalidating maker
  signatures.
- Cross-chain BTC↔FRC HTLC swaps (a taker-first anti-griefing protocol; 3-branch HTLC with
  a cooperative-cancel leaf), coordinated by an untrusted relay.

## The part I think you'll care about most

What we built is, in essence, an implementation of your and Jorge's 2013 *Freimarkets* spec —
asset tags as Hash160 of the definition (host = genesis hash, 0-hash within a definition tx),
tokens as per-asset bitstring sets, per-asset demurrage/interest, authorizer signatories,
sub-transactions with granularity for partial fills, and miner-matched crossover offers. Where
the 2013 spec carried the asset tag as an nVersion=3 output prefix (a hard fork), we moved it
INTO the output's scriptPubKey — the **extension-output push** your v13.2 release notes describe
as "an unconstrained field ... for things like confidential transactions or issued assets, or
commitments to these values." Concretely:

    host  output:  0014{hash20}                              (unchanged)
    asset output:  0014{hash20} <push tag20> OP_1            (fungible asset, ext version 1)
    asset+tokens:  0014{hash20} <push tag20> <push H(set)> OP_2

With this, an asset issuance or transfer is a **plain version-2 transaction** that un-upgraded
nodes parse, relay, and mine unchanged — asset rules sit as a soft-fork overlay. The consensus
derives the tag from the scriptPubKey on any version; conservation is enforced independent of tx
version. On the wire an issuance or transfer is byte-indistinguishable from an ordinary
transaction (verified live: v=2, tag inside the spk, conservation held). The DEX, which carries
witness-side descriptor data, uses the extended tx version, as does the token machinery.

## Two encoding decisions we made (grounded in your docs), for your sanity-check

Since your v13.2 notes already name "issued assets ... or commitments to these values" as the
field's purpose, we didn't want to burden you with permission questions — but two form choices
are worth flagging in case you'd steer them differently:

1. **Tag form.** We adopted the multi-push, versioned-suffix shape from the Forward Blocks
   paper (§XI): after the base program (and optional shard prefix) come one or more data
   pushes, then a MANDATORY trailing "extended output version" as a small-int opcode
   (OP_0..OP_16). So an asset output is `tag(20-byte push) OP_1`, and a token-bearing one is
   `tag(20) H(token-set)(32) OP_2`. The version-being-last makes the field self-describing, so a
   later confidential-output or commitment type can share the same suffix without colliding on
   length. I widened Freicoin's `IsWitnessProgram` walk to accept this (it previously took a
   single optional extension push); the change is small and I'm happy to send the diff. If the
   version-opcode numbering or the "version last" convention isn't what you intended for §XI,
   that's the one place I'd want your steer before it ossifies.

2. **Tokens.** We kept smart-property tokens on the existing extended-version path for now
   (they work; nothing on the exchange uses them yet). When a token use case arrives we plan to
   commit H(token-set) in the extension push and reveal the tokens witness-side, with a
   two-sided reveal (a spender proving an input coin's tokens against its committed hash). If
   there's a coinbase-payout-queue / maturation interaction from the Freimarkets or Forward
   Blocks design we should respect there, we'd rather learn it before building.

## The one question that's really yours

**Path to mainnet.** Assuming the encoding is acceptable, what would you want to see before an
asset soft-fork could be considered for a Freicoin deployment — and is this something you'd be
open to collaborating on or reviewing? We're not asking you to adopt anything; we'd value your
direction on whether this is a road worth continuing down inside Tradecraft or as a separate
effort.

Thank you for the years of work this all builds on — the demurrage kernel, the witness
grammar, and the Forward Blocks framing in particular made this possible. I'm glad to share
the full source, the reference model, the test vectors, or a walkthrough whenever it's
useful.

Best regards,
Kirill
[your name / links / preferred contact]
