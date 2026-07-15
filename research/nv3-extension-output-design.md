# nv3 assets as Freicoin extension outputs — migration spec

**Goal:** move the nVersion=3-lite asset tag from a hard-fork wire change (a parallel
version-3 serialization block after `vout`, gated on `NV3_TX_VERSION`) INTO the output's
scriptPubKey, using the **extension-output push** Freicoin reserved in its witness-program
grammar back in v13.2. Result: an asset-bearing transaction is a STANDARD tx that pre-nv3
nodes parse, relay and mine unchanged — asset consensus becomes a **soft-fork overlay**, not
a hard fork. This is the encoding Friedenbach's own release notes said the reserved fields are
"likely to be used [for] Forward Blocks."

## Encoding (verified in core/asset-spk.mjs, 11/11 round-trip tests)

Freicoin witness program (src/script/script.cpp `IsWitnessProgram`), §XI suffix form:
```
<version opcode> <commitment push 2..75> [shard prefix] [extension SUFFIX]
    suffix = <data push 2..75>{1..N} <version: OP_0..OP_16>   — version is MANDATORY and LAST
```
Asset tag rides the suffix's data pushes; the trailing small-int opcode is the extended-output
version (self-describing so future extension types share the field unambiguously):
```
host  output:  0014{hash20}                              (unchanged — no suffix)
asset (v1):    0014{hash20} 14{tag}                OP_1   (fungible; ext version 1)
asset (v2):    0014{hash20} 14{tag} 20{H(tokenset)} OP_2  (with tokens; tokens revealed
                                                            witness-side, checked against the
                                                            32-byte double-SHA256 commitment)
```
- The trailing version opcode discriminates the cases (v1 fungible / v2 tokens); the 20-byte tag
  (first data push) is ALWAYS public in the output, so the exchange/light-client reads it directly.
- The tag must be the FIRST suffix element: a small-int opcode immediately after the commitment
  (e.g. `...OP_1`) is instead consumed as a shard prefix → host. Assets always lead with a 20-byte
  data push (0x14…), so there is no ambiguity. `0x14` is not a shard-prefix opcode.
- Shard prefix stays UNUSED (reserved for Forward Blocks sharding); decoder skips it.
- C++↔JS byte-parity proven on a standalone g++ harness (scratchpad/suffix-test.cpp, 6/6 incl.
  tokens, p2wsh, shard-prefix-host, and rejection of a suffix missing its version opcode).

## Layers to change (in dependency order)

1. **Reference model (core/)** — the source of truth the C++ mirrors:
   - [DONE] core/asset-spk.mjs — encode/decode codec + tokenSetHash, round-trip tested.
   - core/tx.mjs — drop the version-3 parallel tag/token block; tag now lives in scriptPubKey.
     Outputs become `{value, scriptPubKey}` again; asset identity derived by decodeAssetSpk.
     Tokens move witness-side (new optional block, committed by H(tokenset) in the ext push).
   - core/sighash.mjs — the sighash output serialization must commit to the FULL scriptPubKey
     (which now includes the tag) and NOT to a separate assetTag field. Simplifies hashOutputs.
   - core/nv3chain.mjs, core/assets.mjs — conservation/issuance read the tag via decodeAssetSpk.
   - core/dex.mjs — ranged/bundle descriptors reference the tag through the spk.
2. **C++ consensus (fc-nv3)** — mirror the model:
   - [DONE] script/script.{h,cpp} — `CScript::GetWitnessExtension()` concatenates the §XI suffix
     data pushes (tag20, or tag20++tokenHash32; empty = host), skipping the trailing version opcode;
     `IsWitnessProgram` validates push* + mandatory version opcode. Byte-parity with the JS codec
     proven on a standalone g++ harness (scratchpad/suffix-test.cpp, 6/6 incl. tokens, p2wsh,
     shard-prefix-host, version-missing rejection) — no node rebuild needed for the atom.
   - [NEXT — one focused pass, ends with a node rebuild + harness] the interlocked wiring:
     a. CTxOut: add `void DeriveAssetTag()` = set assetTag from scriptPubKey.GetWitnessExtension()
        (first 20 bytes; if 52, remember the 32-byte tokenHash on the CTxOut, e.g. a new
        `uint256 tokenCommit`). tokens[] is NO LONGER a wire/chainstate field — it is populated
        per-tx from the FRT1 reveal (below).
     b. Call DeriveAssetTag() in exactly two spots so every tag is derived, never trusted from
        the wire: (i) after UnserializeTransaction fills vout; (ii) when a Coin is built from a
        CTxOut on load (so chainstate carries only scriptPubKey — drop g_txout_serialize_asset_tag
        and the compressor.h assetTag/tokens READWRITE; chainstate shrinks + old-format-identical
        where the gate was off).
     c. primitives/transaction.h — DELETE the `if (tx.version == NV3_TX_VERSION) { ... assetTag
        ... tokens ... }` parallel blocks in BOTH Serialize/Unserialize. Asset transfers are now
        plain v2 txs. (approvals/bundles/ranged/nExpireTime stay behind NV3_TX_VERSION for now.)
     d. tx_verify.cpp CheckTxInputs — add a token-reveal pass mirroring core/nv3wire.mjs bindNv3Tx:
        scan vout for the single OP_RETURN "FRT1" payload, parse (vout→tokens), require
        tokenSetHash(tokens)==CTxOut.tokenCommit for every 52-byte-ext output, reject commit-without
        -reveal / reveal-without-commit / reveal-to-nonexistent-output, then set tx.vout[i].tokens
        so the existing per-asset token-conservation loop (lines ~355-372) runs UNCHANGED.
     e. core_io.cpp / interpreter.cpp — the ~2 remaining assetTag readers: derive or drop.
   - The tx drops NV3_TX_VERSION for pure asset transfers (stays v2). nExpireTime / approvals /
     bundles / ranged (DEX witness-side data) still ride NV3_TX_VERSION — moving them behind v2
     witness flags is a LATER phase.
3. **Wallet (apps/web/src)** — mv-swap-lib sendFrcToSpk, market-view issuance + DEX, mv-verify:
   build asset outputs via encodeAssetSpk; read balances via decodeAssetSpk.
4. **Relay (research/nversion3/market-server.mjs)** — index tags from scriptPubKey.

## Open question for upstream (#108)
Does Friedenbach have reserved semantics/invariants for the extension-output push (e.g. a
specific interpretation for Forward Blocks / confidential outputs) that our asset-tag use should
respect or avoid colliding with? The token-set commitment scheme (H(tokenset) appended to the
tag) is our choice and the most likely point of divergence.

## Design decisions — Q1 (tag form) & Q2 (tokens), resolved 2026-07-15

Freicoin's own v13.2 release notes document the extension-output push as "an unconstrained field
for use by future extensions to place extra information in the output needed for things like
confidential transactions or issued assets, **or commitments to these values**." So using it for
an asset tag is the field's *documented* purpose, not a land-grab — this settles the "may we?"
part of both questions. What remained was FORM, decided here:

**Q1 — asset-tag form: FULL §XI MULTI-PUSH VERSIONED SUFFIX** (revised 2026-07-15, superseding an
earlier "bare push, length-discriminated" call). We adopted the Forward Blocks paper §XI shape:
one or more data pushes followed by a MANDATORY trailing "extended output version" small-int opcode
(OP_0..OP_16), the version being the LAST element. Rationale for the reversal: (1) we work in our
own fork with no external consumers yet, so structure can still change before mainnet — the cost of
adopting the richer form now is near zero and the cost of retrofitting versioning onto a
length-discriminated field later is high; (2) a length discriminator conflates "which extension
type" with "how big is its payload", so a future 33-byte confidential-output commitment and some
future 33-byte asset variant would collide — an explicit trailing version removes that class of
ambiguity entirely; (3) it is Friedenbach's own published shape, so mirroring it maximizes the
chance an eventual upstream merge is a no-op rather than a re-encoding. This required widening
IsWitnessProgram's suffix walk (single optional push → push* + version opcode); GetWitnessExtension
concatenates the data pushes and skips the trailing version. Versions are provisional (our fork):
v1 = fungible asset, v2 = asset + token-commitment; higher reserved. Byte-parity C++↔JS proven
(scratchpad/suffix-test.cpp, 6/6). NOTE: a small-int suffix-version cannot stand alone right after
the commitment (it is eaten as a shard prefix); assets are unaffected because the tag data push
always precedes the version.

**Q2 — smart-property tokens: DONE via the TWO-SIDED FRT1 REVEAL (2026-07-15).** A token-bearing
output commits H(token-set) in its §XI v2 spk suffix (tag ++ hash, OP_2); a coin keeps ONLY that
commitment (chainstate is spk-derived, no token persistence). Moving tokens reveals them in one
OP_RETURN "FRT1" payload with an OUTPUT section (checked vs each output's commitment) AND an INPUT
section for the committed coins being spent (checked vs each spent coin's commitment) — the input
half is required because conservation (out ⊆ in) can't be decided from hashes alone. CheckTxInputs
treats the reveal as the sole authority. Model nv3wire-test 18/18, C++ asset_tests, live token_demo.mjs
all green. (The text below is the SUPERSEDED earlier "deferred" decision, kept for history.)

**[SUPERSEDED] Q2 — smart-property tokens: KEEP on the current NV3 path for now (deferred, not rejected).**
The original Freimarkets 2013 spec (§3.2/§4.1) stores tokens as a plain, sorted output SUFFIX
(bitstring list) with the rule output-tokens ⊆ input-tokens — i.e. tokens directly in the output,
NOT a hash commitment. Our "H(token-set) in the extension push + witness reveal" is a soft-fork
reformulation we introduced, and it works today: tokens ride the existing NV3_TX_VERSION parallel
block, the chainstate stores them, and asset_tests/unique_tokens is green. There is NO exchange
consumer of tokens (fungible assets + DEX + BTC swaps never use them). Building the genuinely-new
two-sided reveal consensus mechanic (reveal input tokens too, checked against each spent coin's
committed hash) ahead of any consumer is premature. When a token-bearing use case arrives, migrate
to the 52-byte H(tokenset) ext-push form (already coded in asset-spk.mjs/nv3wire.mjs) plus a
two-sided FRT1 reveal. Decision captured; implementation intentionally deferred.

Net: the only question that genuinely needs Friedenbach is activation on mainnet (§Path to mainnet).
