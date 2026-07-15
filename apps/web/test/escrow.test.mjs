// arbiter-free 2-of-2 escrow test against a live regtest node: a cooperative release needs
// both signatures, one party alone cannot move the funds, and a stalemated escrow visibly
// melts (demurrage is the whole dispute-resolution mechanism — no third party exists).
import { randomBytes } from 'node:crypto';
import { cliR, check, finish } from './helpers.mjs';
import { configureNetwork } from '../src/services/wallet.mjs';
import { pubkeyCompressed } from '../../../core/ecdsa.mjs';
import { escrowLeaf, escrowAddress, escrowSpk, escrowRelease } from '../../../core/escrow.mjs';
import { timeAdjustValue } from '../../../core/demurrage.mjs';

configureNetwork('regtest');
const NET = 'regtest';
const rand = () => randomBytes(32).toString('hex');
const height = () => Number(cliR('getblockcount'));
const mineAddr = cliR('getnewaddress');
const mine = (n = 1) => cliR('generatetoaddress', String(n), mineAddr);
const spent = (t, v) => !cliR('gettxout', t, String(v));
const spk = () => JSON.parse(cliR('getaddressinfo', cliR('getnewaddress'))).scriptPubKey;

function fund(address, expectSpk, amountFrc) {
  const t = cliR('sendtoaddress', address, String(amountFrc));
  const raw = JSON.parse(cliR('getrawtransaction', t, 'true'));
  const vout = raw.vout.find(o => o.scriptPubKey.hex === expectSpk).n;
  const value = BigInt(Math.round(raw.vout[vout].value * 1e8));
  const refheight = raw.lock_height ?? raw.lockheight ?? raw.refheight;
  mine();
  return { txid: t, vout, value, refheight };
}

// buyer & seller keys; the escrow address is symmetric (BIP67 sort) — order can't matter
const buyer = rand(), seller = rand();
const pB = pubkeyCompressed(buyer), pS = pubkeyCompressed(seller);
const leaf = escrowLeaf([pB, pS]);
check('escrow address independent of pubkey order', escrowAddress(leaf, NET) === escrowAddress(escrowLeaf([pS, pB]), NET));

// fund a 10 FRC escrow
const f = fund(escrowAddress(leaf, NET), escrowSpk(leaf), 10);
const buyerOut = spk(), sellerOut = spk();

// one signature alone cannot release: a witness with only the buyer's sig must be rejected
let soloRejected = false;
try {
  const solo = escrowRelease({ ...f, prevTxid: f.txid, leafHex: leaf, keys: [buyer],
    outputs: [{ value: f.value - 2000n, spk: sellerOut }] });
  cliR('sendrawtransaction', solo.rawtx);
} catch { soloRejected = true; }
check('one signature alone cannot release', soloRejected);

// cooperative release: both sign, split 6 to seller / ~4 to buyer (agreed settlement)
const toSeller = 600000000n, toBuyer = f.value - 2000n - toSeller;
const rel = escrowRelease({ ...f, prevTxid: f.txid, leafHex: leaf, keys: [buyer, seller],
  outputs: [{ value: toSeller, spk: sellerOut }, { value: toBuyer, spk: buyerOut }] });
cliR('sendrawtransaction', rel.rawtx); mine();
check('cooperative 2-of-2 release settles', spent(f.txid, f.vout), rel.txid.slice(0, 12));

// demurrage IS the dispute penalty: quantify the melt a stalemate would cost both parties.
const nominal = 1000000000n;                       // 10 FRC nominal locked
const bleed = n => nominal - timeAdjustValue(nominal, n);
const perDay = bleed(96);                           // ~96 blocks/day on mainnet cadence
check('a stalemated escrow melts for both parties', perDay > 0n,
  `10 FRC locked loses ${(Number(perDay) / 1e8).toFixed(6)} FRC/day — the incentive to settle`);

finish();
