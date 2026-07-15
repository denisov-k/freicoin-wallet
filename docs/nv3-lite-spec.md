# nVersion=3-lite: user-issued assets, smart-property tokens, and a miner-matched DEX for Freicoin

```
Status:  Draft — running on a dedicated experimental chain only; NOT proposed for mainnet activation
Layer:   Consensus (soft-fork overlay: asset data rides inside standard transactions)
Author:  Kirill Denisov (denisov-k)
Based on: "Freimarkets: extending bitcoin protocol with user-specified bearer instruments,
          peer-to-peer exchange, off-chain accounting, auctions, derivatives and transitive
          transactions" (M. Friedenbach, J. Timón, 2013) and the extension-output format of
          "Forward Blocks" §XI (M. Friedenbach, Scaling Bitcoin 2018)
Date:    2026-07-15
```

## 1. Abstract

This document specifies **nVersion=3-lite** ("nv3"), a minimal, deliberately conservative
subset of the 2013 Freimarkets proposal, implemented and running on a live experimental
Freicoin-derived chain. It adds to Freicoin consensus:

1. **Fungible user-issued assets**, each with its own demurrage or interest rate expressed as a
   power-of-two shift, validated by per-asset present-value conservation — the uniquely
   Gesellian part: assets that melt (or grow) at their own rate, using the same kernel as the
   host currency.
2. **Extension outputs**: the asset identity of an output is carried *inside* its
   `scriptPubKey` as a Forward-Blocks-§XI suffix, so an asset-bearing transaction is a
   syntactically standard transaction that pre-nv3 nodes parse, relay and store unchanged.
3. **Smart-property tokens**: unique indivisible bitstrings attached to an output, committed
   on-chain by hash only and conserved under a two-sided reveal rule.
4. **Expiring transactions and offers** (`nExpireTime`, the mirror of `nLockTime`).
5. **Issuer authorizers**: opt-in per-asset transfer approval (restricted instruments).
6. **A decentralized exchange**: maker offers as signed sub-transaction *bundles* (all-or-nothing,
   with change) and *ranged bundles* (partial fills at a signed price ratio, fill amount chosen
   by the miner), spliced by any matcher into one balanced transaction.

Everything here exists twice, mirrored bit-for-bit: an executable JavaScript reference model
(`core/*.mjs`, the normative artifact this document describes) and a C++ node implementation
(branch `nv3-lite` of the Tradecraft tree). Where prose and tested code disagree, the code is
authoritative; discrepancies are bugs in this document.

## 2. Design principles

- **The fatal-risk-free subset.** Everything from the 2013 whitepaper whose failure mode is
  catastrophic is excluded: no `decimal64` amounts (floating point in consensus is a chain-split
  risk — per-asset granularity substitutes), no extrospection opcodes (a DoS vector by the
  authors' own assessment — HTLC atomic swaps substitute), no new script opcodes at all.
- **Integer kria everywhere.** All amounts are `int64` kria with `MAX_MONEY = 2^53 − 1`.
- **One kernel.** Per-asset value adjustment generalizes the host demurrage function; the host
  currency is exactly the asset `{shift=20, demurrage}` and is bit-identical to legacy behavior.
- **Model first.** Every consensus rule was written and tested as an executable model before
  being ported; golden vectors pin the two implementations to each other bit-for-bit.
- **Soft-fork shape.** No transaction, block or UTXO serialization visible to old nodes changes.
  New rules only *restrict* validity. (Deployment still requires an activation mechanism —
  §13.)
- **No unilateral activation.** The rules run on a dedicated experimental chain. This document
  is a description and an upstream proposal, not an activation plan.

## 3. Notation and constants

| name | value | meaning |
|---|---|---|
| `NV3_TX_VERSION` | `0x80000003` | tx version carrying nv3 extended fields (deliberately not `3`: Bitcoin's TRUC v3 semantics are untouched) |
| host tag | 20 zero bytes | the host currency (freicoin); written ∅ below |
| `MAX_MONEY` | 2^53 − 1 kria | per-amount sanity bound (not the money supply) |
| `FRA1` | `46 52 41 31` | asset-definition payload magic |
| `FRT1` | `46 52 54 31` | token-reveal payload magic |
| `FRAPPROV` | 8 ASCII bytes | authorizer approval digest prefix |
| `SIGHASH_BUNDLE` | `0x40` | bundle-scoped signature flag (composes with base types) |
| `SIGHASH_NO_LOCK_HEIGHT` | `0x100` | pre-existing Freicoin flag; always masked out of preimages |

`compactSize`, `varstr` (= `compactSize(len) ‖ bytes`), and little-endian integer encodings are
as in Bitcoin. "PV" = present value. `dSHA256` = SHA256(SHA256(·)). `Hash160` =
RIPEMD160(SHA256(·)). A *coin* is a UTXO entry `{value, scriptPubKey, refheight}`; in Freicoin
every coin carries the `refheight` at which its nominal value was minted.

## 4. Extension outputs (script layer)

### 4.1 Witness-program grammar

Freicoin's segwit already defines witness programs with an optional shard prefix and an
optional §XI *extension suffix*. The full normative grammar (`CScript::IsWitnessProgram`):

```
witness-program := version-op  push(2..75 bytes)  [shard]  [suffix]
version-op      := OP_0 | OP_1NEGATE | OP_1..OP_16
shard           := 0x01 <byte b: b ≥ 0x10 and b ≠ 0x80>     ; two-byte form
                 | OP_1NEGATE | OP_1..OP_16                  ; one-opcode form
suffix          := datapush*  ext-version
datapush        := direct push of 2..75 bytes (opcodes 0x02..0x4B)
ext-version     := OP_0 | OP_1..OP_16                        ; MANDATORY, LAST
```

Total script length must be 4..155 bytes. A suffix, when present, MUST end with the
extended-output version opcode; a dangling suffix (pushes with no trailing version, or any
other opcode inside) makes the script *not* a witness program. Putting the version last makes
the suffix self-describing, so future extension types can share the field unambiguously.

### 4.2 Asset suffix

nv3 assigns two (provisional) extended-output versions:

```
host output      :  <base program>                                      (no suffix)
fungible asset   :  <base program> PUSH20(assetTag)                OP_1  (v1)
asset + tokens   :  <base program> PUSH20(assetTag) PUSH32(commit) OP_2  (v2)
```

where `assetTag` is the 20-byte asset id (§5) and `commit` is the 32-byte token-set commitment
(§9.1). Decoding is length-keyed: concatenate the suffix's data pushes (excluding the trailing
version opcode); 20 bytes of extension data ⇒ the asset tag; 52 bytes ⇒ tag ‖ token commitment;
**any other length (including none) ⇒ the output is host currency**. `OP_RETURN` outputs are
never witness programs and are therefore always host.

> *Reservation.* The current implementation derives asset meaning from the data length, not
> from the trailing version value; v1/v2 are the canonical encodings wallets emit. Future
> extension-output types sharing this suffix MUST NOT use bare 20- or 52-byte payloads with
> different semantics.

### 4.3 Derived fields and the base program

Nothing beyond `(value, scriptPubKey)` is serialized for an output — on wire, in the txid, or
in the UTXO database. The asset tag and token commitment are *derived* from the scriptPubKey
(`CTxOut::DeriveAssetTag`, on deserialization and coin construction). Consequences:

- **Old-node compatibility**: pre-nv3 nodes see standard transactions paying to standard
  witness programs; relay, mempool, blocks and the UTXO set are byte-identical.
- **`GetWitnessBase()`** = version-op + program push only (shard and suffix stripped). Spending
  an asset output executes the *base* program — the suffix does not affect spendability. The
  DEX destination checks (§10.3) and the light-client filter (§12) compare/index base programs.
- The 20-byte tag is public in every output; nv3 has no confidential assets.

## 5. Asset definitions

### 5.1 Canonical definition bytes

An asset is declared by an `OP_RETURN` output whose first push is:

```
"FRA1" ‖ def
def = shift(1) ‖ flags(1) ‖ granularity(8, LE) ‖ contractHash(32) [‖ authorizer(33)]
```

- `shift` — the rate exponent `k`; MUST be in `[1, 64]` (the kernels are undefined outside;
  a payload with `shift` out of range is simply *not a definition*).
- `flags` bit 0 (`0x01`): interest (grows) instead of demurrage (melts).
  `flags` bit 1 (`0x02`): an authorizer pubkey is appended.
- `granularity` — minimum divisible unit; `0` is read as `1`. Every output amount of the asset
  MUST be a whole multiple of it (`bad-txns-asset-granularity`).
- `contractHash` — 32 bytes referencing an external contract document; carried, not interpreted.
- `authorizer` — a 33-byte compressed pubkey (`0x02`/`0x03` prefix); present iff flags bit 1 is
  set (any mismatch of flag, length or prefix ⇒ not a definition).

The **asset id** (= the tag used in outputs) is `Hash160(def)` over the *whole* def, so every
parameter — including the authorizer — is committed in the id: change anything and it is a
different asset. The payload length must be exactly `4+42` or `4+42+33` bytes.

### 5.2 Issuance rules

A transaction *defines* at most one asset: the first output that parses as a definition wins;
further candidate payloads are ignored. For a defining transaction:

- The defined asset is **minted from nothing**: outputs tagged with the new id are exempt from
  the conservation rule (§7). The issue size is bounded only by per-output `MAX_MONEY`.
- The transaction MUST mint — at least one output must carry the new id
  (`bad-txns-asset-mints-nothing`).
- The id MUST NOT already be defined (`bad-txns-asset-redefined`). This is security-critical:
  definition bytes are public in the issuance transaction, so without this rule anyone could
  re-publish them and inflate the asset at will.
- Host-currency inputs pay the fee as usual.

Connected definitions enter the **asset registry** (id → `{shift, interest, granularity,
authorizer}`), which is consensus state rebuilt from definition transactions (rolled back on
disconnect; persisted across restarts as an implementation matter, §13). The host currency is
implicit: ∅ → `{shift=20, demurrage, granularity=1}`.

Asset **destruction** needs no rules: paying an asset (or token) to an unspendable output
satisfies conservation and creates no UTXO.

## 6. Value adjustment (the per-asset kernel)

The present value at height `h` of a coin `(value, refheight)` of an asset with shift `k`,
where `d = h − refheight ≥ 0`:

- **demurrage**: `PV = value · (1 − 2^(−k))^d` — computed by the fixed-point
  square-and-multiply ladder with ≥ 96 fractional guard bits; at `k = 20` it reproduces the
  host currency's canonical table bit-for-bit (naive 64-bit squaring drifts and MUST NOT be
  used).
- **interest**: `PV = value · (1 + 2^(−k))^d` — 64.64 fixed point, truncation after every
  multiply, **saturating at `MAX_MONEY`** (a bond stops growing at the cap).

Outputs are minted at the transaction's `lock_height`, so a fresh output's PV equals its
nominal value; melting/growth starts from there.

## 7. Per-asset conservation

Balances are tallied **per asset** (key = the 20-byte tag). For each transaction:

```
for every asset a:   in_pv[a]  = Σ PV(coin, tx.lock_height) over inputs tagged a
                     out[a]    = Σ nominal value over outputs tagged a
rules:               out[a] ≤ in_pv[a]                     (bad-txns-in-belowout)
                     a = ∅ :  fee = in_pv[∅] − out[∅]      (fee is host-only)
                     a ≠ ∅ :  out[a] = in_pv[a] exactly     (bad-txns-asset-not-conserved)
```

The newly-defined asset of a definition tx (§5.2) is exempt. Every input's and output's tag
must be ∅, the tx's own minted id, or a registered asset (`bad-txns-unknown-asset`) — checked
*before* any present-value math, since an unknown asset has no rate. Standard Freicoin rules
(coinbase maturity; monotonic `lock_height`: `tx.lock_height ≥ coin.refheight`, relaxed for
zero-valued inputs under protocol-cleanup) apply per input; `MoneyRange` is enforced on every
accumulation. With an empty registry and no suffixed outputs, all of this reduces exactly to
the pre-nv3 single-asset rule.

## 8. Transaction format (`NV3_TX_VERSION`)

A v3 transaction extends serialization in two places; **everything below is absent (and the
encoding byte-identical to legacy) for any other version**:

1. **`nExpireTime`** (uint32): appended after `lock_height` in the base serialization (thus
   inside the txid). The tx MUST NOT be included in a block of height `> nExpireTime`
   (`bad-txns-expired`); `0` = never expires. The mirror of `nLockTime` ("not after"), and the
   primitive behind expiring offers. It is also committed in every signature preimage (§11.1) —
   otherwise a third party could impose an expiry on a signed transaction.
2. **Witness-side records**, gated by bits of the segwit marker flags byte, each record
   required to be non-empty when its flag is set, all excluded from the txid (they are
   authorization data, like witnesses):
   - flag bit 1 — the standard witness stack;
   - flag bit 2 — `approvals`: vector of `(assetTag uint160, DER signature varstr)` (§9.2);
   - flag bit 4 — `bundles`: vector of `CBundle = {nIn u32, nOut u32, nExpireTime u32}`;
   - flag bit 8 — `ranged`: vector of `CRangedBundle = {nIn u32, payoutAsset uint160,
     payoutScript varstr, priceNum u64, priceDen u64, changeScript varstr, minFill i64,
     maxFill i64, nExpireTime u32}`.

### 8.1 The bundle partition

Bundles partition a *flat* transaction into maker-owned slices; the per-asset conservation of
§7 runs over the whole flat transaction, so composites inherit every balance rule unchanged.

- Fixed bundles claim `vin`/`vout` slices consecutively from index 0, in declaration order:
  bundle *j* owns the next `nIn_j` inputs and `nOut_j` outputs.
- Ranged bundles follow, each claiming the next `nIn` inputs and **exactly two** outputs:
  `[payout, change]`.
- Remaining inputs/outputs belong to the matcher (fee funds, spread, change).
- Sanity (`bad-txns-bundle-empty`, `bad-txns-ranged-descriptor`, `bad-txns-bundle-partition`):
  every `nIn, nOut ≥ 1`; ranged `priceNum, priceDen > 0`, `0 ≤ minFill ≤ maxFill`; claimed
  totals fit inside `vin`/`vout`.
- Every bundle MUST be unexpired at inclusion height (`bad-txns-bundle-expired`) — a maker's
  stale offer only invalidates a composite that *includes* it.

## 9. Smart-property tokens (two-sided reveal)

### 9.1 Commitment

A token is an arbitrary bitstring, unique **per asset**. An output holding tokens commits to
its full token set in the v2 suffix (§4.2):

```
commit = dSHA256( compactSize(n) ‖ n × varstr(token) )
```

The chainstate stores only this 32-byte commitment (derived from the scriptPubKey), never the
tokens themselves.

### 9.2 Reveal payload

Because conservation cannot be decided from hashes alone, a transaction that creates *or
spends* token-committed outputs carries **one** `OP_RETURN` payload:

```
"FRT1" ‖ out-section ‖ in-section
section = compactSize(n) ‖ n × ( compactSize(index) ‖ compactSize(count) ‖ count × varstr(token) )
```

The out-section names this transaction's committed outputs; the in-section names the committed
coins being spent. Malformation — a second `FRT1` output, an index out of range or repeated, a
short read, trailing bytes — invalidates the transaction (`bad-txns-token-reveal`).

### 9.3 Rules

With `R_in`/`R_out` the parsed reveal maps (the reveal is the sole authority; any wire-supplied
token fields are ignored):

- every input coin with a non-null commitment MUST have an `R_in` entry whose `TokenSetHash`
  equals the coin's commitment (`…-token-input-unrevealed` / `…-token-input-mismatch`); an
  entry for an uncommitted input is invalid (`…-token-input-uncommitted`);
- symmetrically for every output and `R_out` (`…-token-output-*`);
- no token may appear in two outputs of the same asset (`bad-txns-token-duplicate`);
- every output token must appear among the input tokens *of the same asset*, unless the asset
  is being minted by this transaction's definition (`bad-txns-token-created`);
- input tokens absent from the outputs are destroyed (allowed — no rule needed).

## 10. Authorizers

If a moved asset's definition names an authorizer, the transaction is invalid without that
authorizer's approval (`bad-txns-asset-not-authorized`): an entry `(tag, sig)` in the
witness-side `approvals` vector where `sig` is a DER ECDSA signature by the authorizer key over

```
dSHA256( "FRAPPROV" ‖ txid (32 bytes, internal order) ‖ tag (20 bytes) )
```

(`bad-txns-asset-authorization-invalid` on verification failure). Approvals ride outside the
txid, so the signature is not circular; the txid already commits to every output, tag, token
and expiry. Minting is exempt — the issuer chooses the authorizer in the definition itself.
This is strictly opt-in per asset and enables restricted instruments (KYC'd shares,
transfer-controlled tickets) without affecting permissionless assets.

## 11. Signature hashes

### 11.1 Base SegwitV0 changes

Freicoin's BIP143 variant already inserts `refheight` (int64, after `amount`) and `lock_height`
(uint32, after `nLockTime`), and masks `SIGHASH_NO_LOCK_HEIGHT` out of the trailing sighash
word. nv3 adds, **for v3 transactions only**:

- `nExpireTime` (uint32) serialized after `lock_height` in the preimage;
- inside `hashOutputs` / the SINGLE output hash, each output serializes as
  `value(8) ‖ varstr(scriptPubKey) ‖ compactSize(n_tokens) ‖ n × varstr(token)` — the
  scriptPubKey is the *full* script including the extension suffix, so **every signature
  commits to which asset (and which token set) each output pays**. Without this, a third party
  could re-tag equal-valued outputs of different assets after signing (tag-swap malleability
  that conservation alone does not always catch). Non-v3 preimages are byte-identical to
  legacy. All sighash paths (BIP143 ALL/SINGLE, taproot, legacy) carry the same commitment.

### 11.2 `SIGHASH_BUNDLE` (0x40) — the bundle digest

Composes with the base types. The digest is scoped to the signing input's bundle — nothing
outside the maker's slice enters the preimage, which is what makes bundles splice-safe:

```
version(4)
dSHA256( bundle's input outpoints )            ; hashPrevouts over the SLICE
dSHA256( bundle's input nSequences )           ; hashSequence over the SLICE
outpoint ‖ varstr(scriptCode) ‖ amount(8) ‖ refheight(8) ‖ nSequence(4)
COMMIT                                          ; see below
nLockTime(4) ‖ lock_height(4) ‖ bundle.nExpireTime(4)
(hashtype & ~SIGHASH_NO_LOCK_HEIGHT)(4)
→ dSHA256
```

For a **fixed bundle**, `COMMIT = dSHA256(serialization of the bundle's output slice)` (v3
output form, §11.1) — the maker signs their exact inputs, outputs (with tags and tokens),
expiry and the valuation `lock_height`, and nothing else.

`lock_height` in this digest is mandatory and load-bearing: give coins are valued at the
composite's `lock_height`, so a matcher able to re-height a composite would re-value every
maker's give with the signatures intact. (Found by mutation fuzzing of the model; pinned in
both implementations.)

If an input is not covered by any bundle while `SIGHASH_BUNDLE` is set, the digest is defined
as the constant `uint256(1)` — unsatisfiable, so no signature can validate.

### 11.3 The ranged digest

Same shape as §11.2, but `COMMIT = dSHA256(descriptor)`:

```
descriptor = payoutAsset(20)                    ; ∅ = host currency
           ‖ varstr(payoutScript)               ; base program (§4.3)
           ‖ priceNum(8 LE) ‖ priceDen(8 LE)    ; payout kria per give kria
           ‖ varstr(changeScript)
           ‖ minFill(8 LE) ‖ maxFill(8 LE)
```

The fill amount is deliberately absent: one signature serves every admissible fill.

### 10.3 (validation) Ranged materialization

For each ranged bundle, consensus checks the miner-materialized `[payout, change]` pair against
the signed descriptor:

- all give coins are one asset (`bad-txns-ranged-mixed-give`); `give_pv` = their PV sum at
  `tx.lock_height`;
- `fill = give_pv − change.value`, and `minFill ≤ fill ≤ maxFill`
  (`bad-txns-ranged-fill-bounds`);
- destinations: `payout.assetTag = payoutAsset`, `base(payout.scriptPubKey) = payoutScript`,
  `change.assetTag = give asset`, `base(change.scriptPubKey) = changeScript`
  (`bad-txns-ranged-destination`) — base-program comparison, because the matcher appends the
  payout's own asset suffix;
- price, cross-multiplied in 128-bit (no overflow):
  `payout.value · priceDen ≥ fill · priceNum` (`bad-txns-ranged-price`) — **rounding favors
  the maker**; the minimal conforming payout is `⌈fill · priceNum / priceDen⌉`.

## 12. Light clients

BIP158 basic filters index, for every non-`OP_RETURN` output, the full `scriptPubKey` **and**
its `GetWitnessBase()` when the two differ. A light client watches its plain base program
(P2WPKH/P2WSH); without the base entry, asset outputs would never flag a block and asset coins
would be invisible to watch-only wallets. For plain outputs base = script, so the element set
simply dedups.

## 13. Implementation requirements (node)

- **Registry persistence.** The registry is consensus state derived from the chain; a node must
  restore it across restarts (the reference node persists `assets.dat` atomically on every
  (dis)connect that changes it, drops it on `-reindex`) — an in-memory-only registry would make
  every previously defined asset's coins unspendable until reindex.
- **Registry rollback discipline.** Because redefinition is invalid (§5.2), any code path that
  registers definitions on a *provisional* basis — dry-run block validation
  (`TestBlockValidity`, `VerifyDB`) or a block that fails after some of its definitions were
  registered — MUST roll those registrations back, or the real connection of the same block
  would spuriously fail `bad-txns-asset-redefined`. (The reference node uses an RAII rollback
  in `ConnectBlock` plus a registry snapshot guard around `VerifyDB`.)
- **Mempool.** Standard: expired-by-`nExpireTime` txs and expired bundles are unminable and
  should be evicted at the new tip; a definition tx conflicts with any other definition of the
  same id.

## 14. The DEX (informative)

The consensus surface above is deliberately mechanism-only; the exchange is what it composes
into:

- **Phase 1 — plain offers** (no new consensus at all): one input ↔ one output at the same
  index, signed `SIGHASH_SINGLE|ANYONECANPAY` — "you may take this coin IF this exact output
  is at my index". Any party (typically a miner) splices crossing offers — pairs or N-way
  *rings* (transitive payments: A gives X wants Y, B gives Y wants Z, C gives Z wants X) — into
  one balanced transaction, adds fee funds, keeps the spread. Makers can be offline at match
  time.
- **Phase 2a — bundles** (§8.1, §11.2): offers with change back to the maker, multiple outputs,
  per-offer expiry; all-or-nothing.
- **Phase 2b — ranged** (§8.1, §11.3, §10.3): the maker signs a constraint — price floor, fill
  bounds, destinations — and the miner picks the amount; partial fills without maker
  interaction.
- **Zero-consensus patterns** proven on top: Dutch auctions (a ladder of expiring ranged offers
  over one coin — double-spend as mutual exclusion), English auctions (deadline-expiring bids
  as bundles, seller countersigns the best), double auctions (the book itself), American
  call/put options (escrowed underlying + pre-signed exercise bundle whose `nExpireTime` is the
  option expiry + CLTV refund path).

The matcher earns the spread and pays the (host-currency-only) fee; miners are natural
matchers, but anyone can match. Maker safety derives entirely from the signature scope: price
floor and fill bounds are consensus-enforced, so the worst a matcher can do is fill within the
signed constraint.

## 15. Security considerations

- **Re-issuance** (§5.2): definition bytes are public; the redefinition rule is what makes an
  asset's supply fixed by its issuance history. Nodes lacking it accept unlimited inflation of
  any asset.
- **Tag/token-swap malleability** (§11.1): signatures commit full scriptPubKeys (hence tags)
  and token sets. The extension-output encoding makes the tag commitment automatic — the tag
  *is* part of the script.
- **Composite re-heighting** (§11.2): bundle digests pin `lock_height`; without it, signatures
  survive re-valuation of every give coin. Found by mutation fuzzing; do not relax.
- **Imposed expiry** (§8): `nExpireTime` is inside the txid *and* every sighash preimage.
- **Rounding** (§10.3): payout rounds up (maker-favoring); implementations MUST use ≥128-bit
  intermediates for the price cross-multiplication.
- **Interest saturation** (§6): growth clamps at `MAX_MONEY`; conservation arithmetic is
  `MoneyRange`-checked at every accumulation.
- **Unconditional enforcement caveat.** The experimental node enforces these rules from
  genesis of its own chain. Deploying on an existing chain requires an activation gate
  (version-bits / height): with the rules active, a suffix-tagged output of an unregistered
  asset is invalid (`bad-txns-unknown-asset`), which is a new restriction relative to plain
  Freicoin nodes and follows the usual soft-fork deployment discipline.
- **DoS surface.** No new opcodes, no unbounded computation: definition parsing is linear in
  payload size, the reveal is linear in its own size and hard-capped by the single-`OP_RETURN`
  form, ranged checks are O(bundles). The registry grows one entry per (feed-paying) definition
  transaction.

## 16. Deliberate exclusions

| whitepaper feature | status | substitute |
|---|---|---|
| `decimal64` amounts | excluded permanently from -lite | per-asset granularity + display scale |
| extrospection opcodes (`OUTPUT_EXISTS`/`OUTPUT_SPENT`) | excluded (DoS vector, per the authors) | HTLC atomic swaps |
| validation scripts (`scriptValidPubKey/Sig`) | not needed so far | options & auctions compose from bundles + expiry |
| private accounting servers | executable model only (`core/accounting.mjs`) | production is an ops project, not consensus |

## 17. Reference implementations and verification

- **Model (normative):** `freicoin-wallet/core/` — `asset-spk.mjs` (§4), `assets.mjs` (§5–7),
  `nv3wire.mjs` (§8–9), `sighash.mjs` (§11), `dex.mjs` (§14), `nv3chain.mjs` (state machine);
  test suites under `apps/web/test/` (assets, nv3chain, dex, sighash golden vectors).
- **Node:** Tradecraft tree, branch `nv3-lite` — `consensus/asset.h` (§5, §9),
  `consensus/tx_verify.cpp::CheckTxInputs` (§7–10 in validation order),
  `primitives/transaction.h` (§8), `script/script.cpp` (§4), `script/interpreter.cpp` (§11),
  `blockfilter.cpp` (§12); unit suite `test/asset_tests.cpp` (12 cases: per-asset validation,
  issuance, redefinition, UTXO persistence, unique tokens, expiry, interest, registry
  serialization, sighash tag commitment, authorizers, bundles, ranged).
- **Cross-verification:** golden vectors pin JS↔C++ bit-for-bit (demurrage/interest ladders
  incl. saturation edges, sighash digests, token commitments, approval digests); the model was
  mutation-fuzzed (which found the `lock_height` re-valuation hole, §11.2); every phase has a
  live end-to-end demo with real keys on the experimental chain
  (`research/nversion3/*_demo.mjs`).

## 18. Acknowledgements

The design is a subset of Freimarkets (Friedenbach & Timón, 2013); the extension-output
encoding is Forward Blocks §XI (Friedenbach, 2018). The contribution of this work is the
*-lite* cut — choosing the fatal-risk-free subset — plus the executable-model-first
methodology, the two-sided token reveal, the ranged-fill descriptor digest, and the running,
cross-verified implementation pair.
