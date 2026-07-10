# Per-asset CheckTxInputs — C++ design (maps from core/nv3chain.mjs)

The next consensus increment after the data layer verifies. Generalises
`Consensus::CheckTxInputs` (src/consensus/tx_verify.cpp) from single-asset
(`nValueIn >= value_out`, fee = difference) to PER-ASSET balance, exactly as
`Nv3State.check()` does in the model.

## Registry dependency
Validation needs each asset's rate. An **asset registry** maps
`assetTag (uint160) -> {k, interest, granularity}`, built from asset-definition
txs as blocks connect (ConnectBlock) and rolled back on disconnect. First cut:
a LevelDB index like the block-final tx index, or an in-memory map rebuilt at
startup. `CheckTxInputs` takes a `const AssetRegistry&` (host currency = null
tag = {k:20, interest:false, granularity:1}, always known).

## Present value per asset
Replace `coin.GetPresentValue(tx.lock_height)` (which uses the FRC kernel) with
`TimeAdjustValueForwardK(coin.out.GetReferenceValue(), tx.lock_height - coin.refheight, reg.rate(tag).k)`
for the coin's asset tag. (Interest assets deferred — reject non-host interest
for now, or gate behind a later representation.)

## The check (mirrors Nv3State.check)
```cpp
// group inputs by asset tag → present value at tx.lock_height using that asset's k
std::map<uint160, CAmount> in_pv, out_sum;
for (const CTxIn& txin : tx.vin) {
    const Coin& coin = inputs.AccessCoin(txin.prevout);
    const uint160& tag = coin.out.assetTag;
    const AssetParams& a = reg.get(tag);                 // host (null) always present
    CAmount pv = TimeAdjustValueForwardK(coin.out.GetReferenceValue(),
                                         tx.lock_height - coin.refheight, a.k);
    in_pv[tag] += pv;                                     // + MoneyRange checks
}
// the asset being defined by THIS tx (if any) is exempt from the input>=output rule
uint160 minted = tx.IsAssetDefinition() ? tx.GetDefinedAssetTag() : uint160();
for (const CTxOut& o : tx.vout) {
    out_sum[o.assetTag] += o.nValue;                     // fresh outputs: pv == nominal
    // granularity: o.nValue % reg.get(o.assetTag).granularity == 0
}
CAmount txfee_aux = 0;
for (auto& [tag, out] : out_sum) {
    if (tag != minted && !reg.has(tag) && !tag.IsNull()) return Invalid("bad-txns-unknown-asset");
    CAmount in = in_pv.count(tag) ? in_pv[tag] : 0;
    if (tag == minted) continue;                          // minted from nothing
    if (out > in) return Invalid("bad-txns-in-belowout");
    if (tag.IsNull()) txfee_aux = in - out;               // host currency leaves the fee
    else if (in != out) return Invalid("bad-txns-asset-not-conserved");
}
// (also assets present only in inputs must balance to zero outputs — same loop over in_pv keys)
txfee = txfee_aux;
```

## Signature / caller changes
- `CheckTxInputs(... , const AssetRegistry& reg, ...)` — thread the registry from
  the CoinsView/chainstate at every call site (validation.cpp ConnectBlock,
  txmempool.cpp, the fuzzer, tests).
- The registry lives beside the CoinsViewCache; ConnectBlock updates it after a
  successful block.

## Test-cascade expected from the data layer (before validation even lands)
Adding 20 bytes/coin to the UTXO serialization changes:
- coins_tests / streams (exact serialized bytes),
- the muhash / UTXO-set-hash (gettxoutsetinfo, assumeutxo snapshot hashes),
- utxo_to_sqlite + any golden UTXO fixtures.
These are EXPECTED and get updated in the build cycle — they confirm the tag is
actually persisted. amount_tests (the kernel) should pass unchanged.
```
