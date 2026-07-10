// nv3chain.mjs — executable model of the nVersion=3-lite CONSENSUS STATE TRANSITION: a tiny
// UTXO-set machine that mirrors what CheckTxInputs + ConnectBlock must do in the C++ node.
// This pins down the rules the port implements: a Coin carries its asset tag; validation is
// per-asset present-value balance at the tx's lock_height; an asset registry (built from
// asset-definition txs) supplies each asset's rate. No node, no build — the design authority.
//
// A Coin  : { assetId, value (nominal kria), refheight, scriptPubKey, coinbase }
// A tx    : { txid, lockHeight, inputs:[outpoint], outputs:[{assetId,value,scriptPubKey}], def? }
//   `def` present ⇒ an asset-definition (mint) tx: it registers the asset and may create it
//   from nothing; every other asset in the tx must still balance and FRC still pays the fee.
import { FRC, assetIdOf, assetPresentValue } from './assets.mjs';

const opkey = (txid, vout) => `${txid}:${vout}`;
const groupSum = (items, key, val) => items.reduce((m, x) => (m.set(key(x), (m.get(key(x)) || 0n) + val(x)), m), new Map());

export class Nv3State {
  constructor() {
    this.utxos = new Map();      // outpoint -> Coin
    this.assets = new Map();     // assetId -> { k, interest }
    this.fees = 0n;              // accumulated FRC fees (present value at spend time)
  }

  rate(id, pendingId, pendingDef) {
    if (id === FRC) return { k: 20, interest: false };
    if (id === pendingId) return pendingDef;
    return this.assets.get(id) || null;
  }

  /** Validate a tx against the current UTXO set + asset registry. Returns {ok, fee} or {ok:false, err}. */
  check(tx) {
    const ins = [];
    for (const op of tx.inputs) {
      const c = this.utxos.get(op);
      if (!c) return { ok: false, err: `input missing or already spent: ${op}` };
      ins.push(c);
    }
    const mintedId = tx.def ? assetIdOf(tx.def) : null;
    if (tx.def && this.assets.has(mintedId)) return { ok: false, err: 'asset already defined' };
    if (tx.def && tx.outputs.every(o => o.assetId !== mintedId)) return { ok: false, err: 'definition mints nothing' };

    // reject unknown assets BEFORE any present-value math (an unknown asset has no rate)
    for (const id of new Set([...ins.map(c => c.assetId), ...tx.outputs.map(o => o.assetId)]))
      if (id !== FRC && id !== mintedId && !this.assets.has(id)) return { ok: false, err: `unknown asset ${id}` };

    // granularity: each output amount must be a whole multiple of its asset's minimum unit
    // (FRC is fully divisible = 1). Checked at the reference height, per the whitepaper.
    const gran = id => id === FRC ? 1n : BigInt((id === mintedId ? tx.def : this.assets.get(id)).granularity || 1);
    for (const o of tx.outputs)
      if (o.value % gran(o.assetId) !== 0n) return { ok: false, err: `asset ${o.assetId} amount not a multiple of granularity` };

    const inByAsset = groupSum(ins, c => c.assetId, c => assetPresentValue(c.value, tx.lockHeight - c.refheight, this.rate(c.assetId, mintedId, tx.def)));
    const outByAsset = groupSum(tx.outputs, o => o.assetId, o => o.value);   // fresh outputs: pv == nominal
    let fee = 0n;
    for (const id of new Set([...inByAsset.keys(), ...outByAsset.keys()])) {
      if (id !== FRC && id !== mintedId && !this.assets.has(id)) return { ok: false, err: `unknown asset ${id}` };
      const inPv = inByAsset.get(id) || 0n, outSum = outByAsset.get(id) || 0n;
      if (id === mintedId) continue;                    // the defined asset is minted from nothing
      if (outSum > inPv) return { ok: false, err: `asset ${id} inflated: out ${outSum} > in ${inPv}` };
      if (id === FRC) fee = inPv - outSum;
      else if (inPv !== outSum) return { ok: false, err: `asset ${id} not conserved: in ${inPv} != out ${outSum}` };
    }

    // Unique tokens (indivisible smart-property bitstrings, per asset): every output token must
    // come from an input of the SAME asset (or be minted by a definition tx), and no token may
    // appear in two outputs. Tokens not re-output are destroyed (allowed). Keyed per asset, so
    // the same bitstring under different assets is a different token.
    const inTok = new Map();     // assetId -> Set(token)
    for (const c of ins) for (const t of (c.tokens || [])) (inTok.get(c.assetId) || inTok.set(c.assetId, new Set()).get(c.assetId)).add(t);
    const seen = new Set();      // `${assetId}:${token}` guards against duplicate output tokens
    for (const o of tx.outputs) for (const t of (o.tokens || [])) {
      const key = `${o.assetId}:${t}`;
      if (seen.has(key)) return { ok: false, err: `token ${t} of ${o.assetId} output twice` };
      seen.add(key);
      const fromInput = inTok.get(o.assetId)?.has(t);
      if (!fromInput && o.assetId !== mintedId) return { ok: false, err: `token ${t} of ${o.assetId} created from nothing` };
    }

    return { ok: true, fee };
  }

  /** Validate and apply a tx: register any new asset, spend inputs, create outputs. */
  apply(tx) {
    const v = this.check(tx);
    if (!v.ok) return v;
    if (tx.def) this.assets.set(assetIdOf(tx.def), { k: tx.def.k, interest: tx.def.interest, granularity: tx.def.granularity });
    for (const op of tx.inputs) this.utxos.delete(op);
    tx.outputs.forEach((o, i) => this.utxos.set(opkey(tx.txid, i), {
      assetId: o.assetId, value: o.value, refheight: tx.lockHeight, scriptPubKey: o.scriptPubKey, coinbase: false,
      ...(o.tokens && o.tokens.length ? { tokens: o.tokens } : {}),
    }));
    this.fees += v.fee;
    return v;
  }

  /** Seed a coinbase-style coin directly (for tests / genesis funding). */
  seed(txid, vout, coin) { this.utxos.set(opkey(txid, vout), { coinbase: false, ...coin }); return opkey(txid, vout); }

  /** Total present value of every UTXO of one asset at a given height (for invariant checks). */
  supplyPresentValue(assetId, height) {
    let s = 0n;
    for (const c of this.utxos.values()) if (c.assetId === assetId)
      s += assetPresentValue(c.value, height - c.refheight, this.rate(assetId));
    return s;
  }
}
