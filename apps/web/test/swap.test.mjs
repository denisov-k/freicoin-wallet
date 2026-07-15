// swap orchestration test: our wallet drives the FRC leg of a cross-chain swap in both
// roles, against a live regtest node (the node wallet stands in for the counterparty's
// funding). Proves swapKey (seed-recoverable) + role-based frcLeg + claim/refund.
import { randomBytes } from 'node:crypto';
import { cliR, check, finish, SEED } from './helpers.mjs';
import { configureNetwork } from '../src/services/wallet.mjs';
import { pubkeyCompressed } from '../../../core/ecdsa.mjs';
import { paymentHashOf } from '../../../core/htlc.mjs';
import { swapKey, frcLeg, claimReceived, refundGiven } from '../../../core/swap.mjs';

configureNetwork('regtest');
const NET = 'regtest';
const rand = () => randomBytes(32).toString('hex');
const height = () => Number(cliR('getblockcount'));
const mineAddr = cliR('getnewaddress');
const mine = (n = 1) => cliR('generatetoaddress', String(n), mineAddr);
const spent = (txid, vout) => !cliR('gettxout', txid, String(vout));
const outSpk = JSON.parse(cliR('getaddressinfo', cliR('getnewaddress'))).scriptPubKey;

// counterparty funds an HTLC address (stands in for their side locking FRC to us / our lock)
function fund(address, spk, amountFrc) {
  const txid = cliR('sendtoaddress', address, String(amountFrc));
  const raw = JSON.parse(cliR('getrawtransaction', txid, 'true'));
  const vout = raw.vout.find(o => o.scriptPubKey.hex === spk).n;
  const value = BigInt(Math.round(raw.vout[vout].value * 1e8));
  const refheight = raw.lock_height ?? raw.lockheight ?? raw.refheight;
  mine();
  return { txid, vout, value, refheight };
}

// seed-recoverable swap key is deterministic and unique per swap id
const k1 = swapKey(SEED, 'swap-0001'), k2 = swapKey(SEED, 'swap-0001'), k3 = swapKey(SEED, 'swap-0002');
check('swap key deterministic + per-swap unique', k1 === k2 && k1 !== k3);

const preimage = rand();
const H = paymentHashOf(preimage);
const theirKey = rand();                       // the counterparty's key (only their pubkey matters to us)
const theirPub = pubkeyCompressed(theirKey);

// --- role 'receive': counterparty locks FRC to us; we claim with the preimage ---
const kR = swapKey(SEED, 'recv-1');
const legR = frcLeg({ role: 'receive', ourKey: kR, theirPub, paymentHash: H, cltv: height() + 30, net: NET });
const fR = fund(legR.address, legR.spk, 5);
const claim = claimReceived({ funding: fR, leaf: legR.leaf, preimage, ourKey: kR, toSpk: outSpk });
cliR('sendrawtransaction', claim.rawtx); mine();
check("role 'receive': claimed our incoming FRC HTLC with the preimage", spent(fR.txid, fR.vout), claim.txid.slice(0, 12));

// --- role 'give': we lock FRC (refund key ours); the swap stalls; we refund after timeout ---
const kG = swapKey(SEED, 'give-1');
const cltv = height() + 6;
const legG = frcLeg({ role: 'give', ourKey: kG, theirPub, paymentHash: H, cltv, net: NET });
const fG = fund(legG.address, legG.spk, 4);
mine(cltv - height() + 1);
const refund = refundGiven({ funding: fG, leaf: legG.leaf, cltv, ourKey: kG, toSpk: outSpk });
cliR('sendrawtransaction', refund.rawtx); mine();
check("role 'give': refunded our own FRC HTLC after the timeout", spent(fG.txid, fG.vout), refund.txid.slice(0, 12));

// a wrong counterparty (different pubkey) yields a different address — offers can't be confused
const other = frcLeg({ role: 'receive', ourKey: kR, theirPub: pubkeyCompressed(rand()), paymentHash: H, cltv: height() + 30, net: NET });
check('leaf binds the counterparty pubkey (distinct address)', other.address !== legR.address);

finish();
