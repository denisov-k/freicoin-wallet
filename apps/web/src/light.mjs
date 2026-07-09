// light.mjs — a data source backed by the Neutrino light client (variant B),
// exposing the same shape as the variant-C backend (api.mjs) so the UI can use
// either. No trusted backend: balance/UTXOs/history are computed client-side from
// verified headers, BIP157/158 filters and the blocks they flag.
import { Neutrino } from './net/client.mjs';
import { timeAdjustValue } from '../../../core/demurrage.mjs';
import { parseTx, txid as txidOf } from '../../../core/tx.mjs';

const kriaToFrc = k => Number(k) / 1e8;

export function createLightSource({ url, net, genesis, scripts }) {
  let n = null, cache = null;

  async function sync() {
    if (!n) { n = new Neutrino({ url, net, genesis }); await n.connect(); }
    const r = await n.syncWallet(scripts);
    const tip = r.tipHeight;
    cache = {
      tipHeight: tip,
      balance: kriaToFrc(r.balance),
      utxos: r.utxos.map(u => ({
        txid: u.txid, vout: u.vout, refheight: u.refheight,
        nominal: kriaToFrc(u.value),
        amount: kriaToFrc(timeAdjustValue(u.value, tip + 1 - u.refheight)),
        coinbase: u.coinbase, scriptPubKey: u.script,
      })),
      history: r.history.map(h => ({
        txid: h.txid, category: h.category,
        amount: kriaToFrc(h.amount < 0n ? -h.amount : h.amount) * (h.amount < 0n ? -1 : 1),
        confirmations: tip - h.height + 1, time: h.time,
      })),
    };
    return cache;
  }
  const ensure = async () => cache || sync();

  return {
    async health() { return { ok: true, network: net + ' (light)' }; },
    async balance() { const c = await ensure(); return { balance: c.balance, tipHeight: c.tipHeight, unit: 'present-value' }; },
    async utxos() { const c = await sync(); return { balance: c.balance, tipHeight: c.tipHeight, utxos: c.utxos }; },
    async history() { const c = await ensure(); return { txs: c.history }; },
    async broadcast(rawtx) { if (!n) await sync(); n.broadcast(rawtx); return { txid: txidOf(parseTx(rawtx)) }; },
    refresh: sync,
    close() { if (n) { n.close(); n = null; cache = null; } },
  };
}
