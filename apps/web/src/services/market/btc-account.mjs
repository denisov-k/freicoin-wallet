// mv-btc-account.mjs — the in-wallet BTC account (signet), non-custodial via the relay's watch-only
// index. The relay never holds keys or funds: it imports our addresses watch-only, reports their UTXOs
// and rebroadcasts what we sign locally. Trust note: it can hide/mislabel a balance, but never spend it.
// Extracted verbatim from market-view.mjs; reads the live session through `ctx`.
import { ctx, api, p2pKey, btcFeeFor, btcSendFee, VB_HTLC_FUND } from '@/state/market-ctx.mjs';
import { loadP2p, loadBtcNonces, addFundTxid } from '@/services/storage.mjs';
import { btcP2wpkhAddress, btcP2wpkhSpk, btcP2wpkhSend, btcDecodeAddress, btcWif } from '@core/btc.mjs';
import { pubkeyCompressed } from '@core/ecdsa.mjs';
import { sha256 } from '@core/crypto.mjs';
import { derivePath, ckdPriv } from '@core/hd.mjs';
import { tr, getLang } from '@/services/i18n.mjs';

// recoverBtcNonces lives in the activity/recovery domain (market-view) and is injected once so
// refreshBtc can rebuild the address book without an import cycle.
let recoverNonces = null;
export function initBtcAccount(fn) { recoverNonces = fn; }

export const btcHrp = () => ctx.state?.swap?.btcHrp || 'tb';
// The ACCOUNT key is STANDARD BIP84 (m/84'/coin'/0'/0/0, coin 0 = bitcoin mainnet, 1 = test nets)
// from the SAME mnemonic — so the seed phrase alone restores this balance in ANY bitcoin wallet
// (Electrum, Sparrow…), with or without us. Per-swap keys stay hash-derived: they're short-lived
// protocol keys, not a store of value (see btcKeyring). The pre-2026-07-14 account used a custom
// hash derivation — kept below as "legacy"; refreshBtc auto-sweeps its coins over once.
const bip84Priv = () => {
  const coin = btcHrp() === 'bc' ? 0 : 1;
  const node = ckdPriv(ckdPriv(derivePath(ctx.seed, `m/84'/${coin}'/0'`), 0), 0);
  return node.priv.toString(16).padStart(64, '0');
};
export const btcAcctPriv = () => bip84Priv();
export const btcAcctPub = () => pubkeyCompressed(btcAcctPriv());
export const btcAcctAddr = () => btcP2wpkhAddress(btcAcctPub(), btcHrp());
const btcLegacyPriv = () => sha256(Buffer.from(ctx.seed + 'fw-btc-acct:0', 'utf8')).toString('hex');
const btcLegacyAddr = () => btcP2wpkhAddress(pubkeyCompressed(btcLegacyPriv()), btcHrp());

// Every BTC address this wallet controls → its private key: the BIP84 account, the legacy account
// (pre-migration coins stay spendable), PLUS each P2P swap's per-nonce BTC key (live records AND
// the persistent address book). Balance sums them; sends spend any.
export function btcKeyring() {
  const ring = { [btcAcctAddr()]: btcAcctPriv(), [btcLegacyAddr()]: btcLegacyPriv() };
  const nonces = new Set([...loadP2p().map(r => r.nonce).filter(Boolean), ...loadBtcNonces()]);
  for (const n of nonces) { try { const k = p2pKey(n, 'btc'); ring[btcP2wpkhAddress(pubkeyCompressed(k), btcHrp())] = k; } catch {} }
  return ring;
}

let btcAcct = null;   // last { balance, utxos, hrp, net } from the relay
// network switch: the old net's BTC snapshot must not linger on the new net's screen
export function btcResetAcct() { btcAcct = null; }
export const btcToStr = sats => (Number(BigInt(sats)) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 8 });

// One-time MIGRATION: sweep whatever sits on the legacy (custom-derivation) account address onto
// the BIP84 address, so "restore from phrase in any wallet" holds for the whole balance. Internal
// move — the txid goes into the funding book so Activity hides both its legs. Guarded by an
// in-flight marker so two networks' refresh loops (one shared signet account) don't double-sweep.
const MIGR_LS = 'fw_btc_migr';
async function sweepLegacy(utxos) {
  const legacy = btcLegacyAddr();
  const coins = utxos.filter(c => c.address === legacy);
  if (!coins.length) return;
  try {
    const [ptxid, pat] = (localStorage.getItem(MIGR_LS) || ':').split(':');
    if (ptxid && coins.some(c => c.txid === ptxid)) return;              // that's our own pending sweep
    if (ptxid && Date.now() - Number(pat || 0) < 30 * 60e3) return;      // one already in flight
  } catch {}
  let S = 0n; for (const c of coins) S += BigInt(c.value);
  const fee = btcSendFee(coins.length, 1);   // plain move, no deadline — economy tariff
  if (S <= fee + 546n) return;   // dust remainder — not worth a move; stays spendable via the keyring
  const inputs = coins.map(c => ({ prevTxid: c.txid, vout: c.vout, valueSats: BigInt(c.value), key: btcLegacyPriv() }));
  const { rawtx, txid } = btcP2wpkhSend({ inputs, outputs: [{ spk: btcP2wpkhSpk(btcAcctPub()), value: S - fee }] });
  await api('btcBroadcast', { rawtx });
  addFundTxid(txid);   // internal plumbing — never a user send/receive in Activity
  try { localStorage.setItem(MIGR_LS, `${txid}:${Date.now()}`); } catch {}
}

export async function refreshBtc() {
  if (!ctx.state?.swap?.available) return;
  if (recoverNonces) await recoverNonces();   // one-time: rebuild the address book for swaps whose record was dropped
  try { btcAcct = await api('btcAccount', { addresses: Object.keys(btcKeyring()) }); } catch { return; }
  sweepLegacy(btcAcct.utxos).catch(() => {});   // migrate legacy-address coins to the BIP84 account
  const cell = document.querySelector('#btcBalCell'); if (cell) cell.textContent = btcToStr(btcAcct.balance);   // BTC row in the assets table
}

// fund a BTC HTLC from the account (swap plumbing): pick coins, sign locally, broadcast, and remember
// the txid so Activity folds it into the trade row instead of showing a bare send.
export async function btcFundHtlc(toAddr, sats) {
  const toSpk = btcDecodeAddress(toAddr, btcHrp());
  // priced at the relay's live feerate (see mv-ctx): an under-priced HTLC funding that sits in the
  // mempool stalls the whole swap and can push the taker past their own refund window
  const amount = BigInt(sats), fee = btcFeeFor(VB_HTLC_FUND);
  const ring = btcKeyring();
  const acct = await api('btcAccount', { addresses: Object.keys(ring) });
  const coins = [...acct.utxos].filter(c => ring[c.address]).sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  const picked = []; let S = 0n;
  for (const c of coins) { picked.push(c); S += BigInt(c.value); if (S >= amount + fee) break; }
  if (S < amount + fee) throw new Error(tr('not enough BTC'));
  const outputs = [{ spk: toSpk, value: amount }], change = S - amount - fee;
  if (change > 546n) outputs.push({ spk: btcP2wpkhSpk(btcAcctPub()), value: change });
  const inputs = picked.map(c => ({ prevTxid: c.txid, vout: c.vout, valueSats: BigInt(c.value), key: ring[c.address] }));
  const { rawtx, txid } = btcP2wpkhSend({ inputs, outputs });
  await api('btcBroadcast', { rawtx });
  addFundTxid(txid);   // swap plumbing — Activity hides it even if the swap record is later dropped
  return { txid, vout: 0, value: String(amount) };
}

// The wallet's BTC keys as importable WIFs — the escape hatch that keeps "non-custodial" honest:
// any single key drops into Electrum/Sparrow/BlueWallet even if this service is gone. The BIP84
// account is also restorable from the PHRASE alone; per-swap keys exist ONLY here (hash-derived),
// so for them WIF export is the sole exit. Lists both accounts always + any funded swap address.
export function btcExportKeys() {
  const main = btcHrp() === 'bc';
  const bal = new Map();
  for (const u of btcAcct?.utxos ?? []) bal.set(u.address, (bal.get(u.address) ?? 0n) + BigInt(u.value));
  const rows = [], seen = new Set();
  const push = (addr, key, label) => { if (!seen.has(addr)) { seen.add(addr); rows.push({ addr, wif: btcWif(key, main), label, sats: bal.get(addr) ?? 0n }); } };
  push(btcAcctAddr(), btcAcctPriv(), tr('account (BIP84 — the phrase restores it too)'));
  push(btcLegacyAddr(), btcLegacyPriv(), tr('account (legacy)'));
  const nonces = new Set([...loadP2p().map(r => r.nonce).filter(Boolean), ...loadBtcNonces()]);
  for (const n of nonces) { try { const k = p2pKey(n, 'btc'); push(btcP2wpkhAddress(pubkeyCompressed(k), btcHrp()), k, tr('swap address')); } catch {} }
  // only the CURRENT account is always listed; the legacy account and per-swap addresses are
  // history — they appear only while coins actually sit on them
  return rows.filter(r => r.sats > 0n || r.addr === btcAcctAddr());
}

// ---- exports so BTC lives in the wallet's MAIN flow (assets table + Send/Receive), not a side panel ----
/** Is a BTC account available, and its current balance (sats) + address prefix. */
export function mvBtc() { return { available: !!ctx.state?.swap?.available, balance: btcAcct?.balance ?? null, hrp: btcHrp() }; }
/** The account's receive address (and start watching it so incoming funds are seen). */
export function mvBtcAddress() { const a = btcAcctAddr(); api('btcAccount', { addresses: [a] }).catch(() => {}); return a; }
/** True if `a` is a valid address on the BTC network we're on. */
export function mvBtcValidAddr(a) { try { btcDecodeAddress(a, btcHrp()); return true; } catch { return false; } }
/** Build + sign a P2WPKH send LOCALLY (key never leaves the device) and broadcast via the relay. */
// coin selection shared by the send, its fee preview and Max. `fast` picks the tariff (see
// btcSendFee): eco = mempool floor (no deadline), fast = estimator rate. Fee bills the ACTUAL vsize,
// recomputed as inputs are added. Selection/fee are independent of the destination, so the form can
// preview the fee before an address is typed. Returns null on insufficient funds.
async function selectBtcCoins(amount, fast) {
  const ring = btcKeyring();
  const acct = await api('btcAccount', { addresses: Object.keys(ring) });
  const coins = [...acct.utxos].filter(c => ring[c.address]).sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  const picked = []; let S = 0n, fee = 0n;
  for (const c of coins) { picked.push(c); S += BigInt(c.value); fee = btcSendFee(picked.length, 2, fast); if (S >= amount + fee) break; }
  if (S < amount + fee) return null;
  let change = S - amount - fee;
  if (change <= 546n) { fee = S - amount; change = 0n; }   // sub-dust change folds into the fee
  return { ring, picked, fee, change };
}

// fee (sats) the actual send will pay at the chosen speed — for the send form / review. 0n on shortfall.
export async function mvBtcSendFee(amountBtc, fast = false) {
  if (!(amountBtc > 0)) return 0n;
  try { const sel = await selectBtcCoins(BigInt(Math.round(amountBtc * 1e8)), fast); return sel ? sel.fee : 0n; }
  catch { return 0n; }
}

// the largest amount sendable at `fast`: sweep every coin to a single output, minus that fee.
export async function mvBtcMax(fast = false) {
  try {
    const ring = btcKeyring();
    const acct = await api('btcAccount', { addresses: Object.keys(ring) });
    const coins = [...acct.utxos].filter(c => ring[c.address]);
    if (!coins.length) return 0n;
    const S = coins.reduce((a, c) => a + BigInt(c.value), 0n), fee = btcSendFee(coins.length, 1, fast);
    return S > fee ? S - fee : 0n;
  } catch { return 0n; }
}

export async function mvSendBtc(dest, amountBtc, fast = false) {
  if (!(amountBtc > 0)) throw new Error(tr('enter a quantity'));
  let toSpk; try { toSpk = btcDecodeAddress(dest, btcHrp()); } catch (e) { throw new Error(tr('bad address')); }
  const amount = BigInt(Math.round(amountBtc * 1e8));
  const sel = await selectBtcCoins(amount, fast);
  if (!sel) throw new Error(tr('not enough BTC'));
  const outputs = [{ spk: toSpk, value: amount }];
  if (sel.change > 0n) outputs.push({ spk: btcP2wpkhSpk(btcAcctPub()), value: sel.change });   // change back
  const inputs = sel.picked.map(c => ({ prevTxid: c.txid, vout: c.vout, valueSats: BigInt(c.value), key: sel.ring[c.address] }));
  const { rawtx, txid } = btcP2wpkhSend({ inputs, outputs });
  await api('btcBroadcast', { rawtx });
  refreshBtc();
  return txid;
}
