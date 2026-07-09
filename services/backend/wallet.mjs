// wallet.mjs — watch-only wallet operations over freicoind, scoped to an account
// xpub. Address derivation and UTXO scanning are delegated to the node (it does
// descriptor CKDpub and computes demurrage present value), keeping the backend thin.
import { rpc } from './rpc.mjs';
import { config } from './config.mjs';

const WATCH_WALLET = 'fwwatch';   // node-side watch-only wallet for history

// Descriptor chains under the account xpub: 0 = receive, 1 = change (BIP44/84).
let _desc = null;   // { receive: 'wpk(xpub/0/*)#ck', change: 'wpk(xpub/1/*)#ck' }

async function descriptors() {
  if (_desc) return _desc;
  if (!config.accountXpub) throw new Error('FW_ACCOUNT_XPUB not set');
  const withCk = async chain => {
    const raw = `wpk(${config.accountXpub}/${chain}/*)`;
    const info = await rpc('getdescriptorinfo', [raw]);
    return `${raw}#${info.checksum}`;
  };
  _desc = { receive: await withCk(0), change: await withCk(1) };
  return _desc;
}

/** Derive a receive (chain 0) or change (chain 1) address at `index`. */
export async function deriveAddress(index, chain = 0) {
  const d = await descriptors();
  const desc = chain === 0 ? d.receive : d.change;
  const [addr] = await rpc('deriveaddresses', [desc, [index, index]]);
  return addr;
}

/**
 * Scan the UTXO set for this wallet. Returns present-value balance, the spendable
 * UTXOs (amount = present value at the current tip, refheight = coin height), and
 * that tip height — so a client can build a tx with lock_height = tipHeight and
 * spend each input at exactly its reported amount.
 */
export async function scan() {
  const d = await descriptors();
  const res = await rpc('scantxoutset', ['start', [d.receive, d.change]]);
  const tipHeight = await rpc('getblockcount');
  // nominal value (the stored CTxOut.nValue) is what a client must sign over;
  // gettxout returns it, while scantxoutset's `amount` is the present value.
  const utxos = await Promise.all(res.unspents.map(async u => {
    const out = await rpc('gettxout', [u.txid, u.vout, true]);
    return {
      txid: u.txid,
      vout: u.vout,
      amount: u.amount,          // present value (kria-decimal) at the tip
      nominal: out ? out.value : u.amount,   // nominal value (for the sighash)
      refheight: u.height,       // the coin's refheight
      coinbase: !!u.coinbase,
      scriptPubKey: u.scriptPubKey,
    };
  }));
  return { balance: res.total_amount, utxos, tipHeight, height: res.height };
}

/** Relay a client-signed raw transaction. Returns the txid. */
export async function broadcast(rawHex) {
  return rpc('sendrawtransaction', [rawHex]);
}

// --- transaction history via a node-side watch-only descriptor wallet ----------
const walletRpc = (method, params = []) => rpc(method, params, `/wallet/${WATCH_WALLET}`);
let _watchReady = null;

async function ensureWatchWallet() {
  if (_watchReady) return _watchReady;
  _watchReady = (async () => {
    const wallets = await rpc('listwallets');
    if (!wallets.includes(WATCH_WALLET)) {
      try { await rpc('loadwallet', [WATCH_WALLET]); }
      catch {
        // create a blank, private-keys-disabled (watch-only) descriptor wallet
        await rpc('createwallet', [WATCH_WALLET, true, true, '', false, true]);
        const d = await descriptors();
        await walletRpc('importdescriptors', [[
          { desc: d.receive, active: true, internal: false, range: [0, 200], timestamp: 0 },
          { desc: d.change, active: true, internal: true, range: [0, 200], timestamp: 0 },
        ]]);
      }
    }
  })();
  return _watchReady;
}

/** Recent wallet transactions (most recent first), from the watch-only wallet. */
export async function history(count = 25) {
  await ensureWatchWallet();
  const txs = await walletRpc('listtransactions', ['*', count, 0, true]);
  return txs.reverse().map(t => ({
    txid: t.txid,
    category: t.category,            // send | receive | generate
    amount: t.amount,                // present value (node-computed)
    confirmations: t.confirmations,
    time: t.time,
    address: t.address,
  }));
}

/** Lightweight status of a transaction: confirmations (0 if in mempool, null if unknown). */
export async function txStatus(txid) {
  try {
    const entry = await rpc('getmempoolentry', [txid]);
    if (entry) return { txid, confirmations: 0, inMempool: true };
  } catch { /* not in mempool */ }
  try {
    const tx = await rpc('getrawtransaction', [txid, true]);
    return { txid, confirmations: tx.confirmations ?? 0, inMempool: false };
  } catch {
    return { txid, confirmations: null, inMempool: false };
  }
}
