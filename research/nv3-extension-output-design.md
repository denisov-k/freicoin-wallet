# nv3 assets as Freicoin extension outputs — migration spec

**Goal:** move the nVersion=3-lite asset tag from a hard-fork wire change (a parallel
version-3 serialization block after `vout`, gated on `NV3_TX_VERSION`) INTO the output's
scriptPubKey, using the **extension-output push** Freicoin reserved in its witness-program
grammar back in v13.2. Result: an asset-bearing transaction is a STANDARD tx that pre-nv3
nodes parse, relay and mine unchanged — asset consensus becomes a **soft-fork overlay**, not
a hard fork. This is the encoding Friedenbach's own release notes said the reserved fields are
"likely to be used [for] Forward Blocks."

## Encoding (verified in core/asset-spk.mjs, 11/11 round-trip tests)

Freicoin witness program (src/script/script.cpp `IsWitnessProgram`):
```
<version opcode> <commitment push 2..75> [shard prefix] [extension push 2..75]
```
Asset tag rides the extension push:
```
host  output:  0014{hash20}                       (unchanged — no extension)
asset output:  0014{hash20} <push ext>
    ext = tag(20)                     — fungible asset, no smart-property tokens
    ext = tag(20) ++ H(tokenset)(32)  — with tokens; tokens revealed witness-side,
                                        checked against this 32-byte double-SHA256 commitment
```
- Push length (20 vs 52) distinguishes the two cases; the 20-byte tag is ALWAYS public in the
  output, so the exchange/light-client reads it directly (no spend needed).
- `0x14` (20) after the commitment is NOT a shard-prefix opcode (0x01 / OP_1NEGATE / OP_1..16),
  so C++ `IsWitnessProgram` already falls through and accepts it as the extension push.
- Shard prefix stays UNUSED (reserved for Forward Blocks sharding); decoder skips it.

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
   - [DONE] script/script.{h,cpp} — `CScript::GetWitnessExtension()` extracts the extension push
     (20 = tag, 52 = tag++tokenHash, empty = host). Reuses the IsWitnessProgram walk. Byte-parity
     with the JS codec proven on a standalone g++ harness (scratchpad/ext-test.cpp, 5/5 incl.
     tokens + shard-prefix-no-ext) — no node rebuild needed for the atom.
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
