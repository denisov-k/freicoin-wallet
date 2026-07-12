// swap-signet.mjs — a REAL atomic swap: FRC (our fc-nv3 chain) ↔ BTC on the LIVE PUBLIC SIGNET.
// The BTC leg's transactions are broadcast to the real signet network; if signet nodes accept
// them, they are genuine Bitcoin-consensus-valid. FRC leg mines on demand; BTC leg runs at
// 0-conf (the claim spends the unconfirmed HTLC funding — a valid Bitcoin mempool chain).
import { readFileSync } from 'node:fs';
import { sha256 } from '/root/free-money/freicoin-wallet/core/crypto.mjs';
import { pubkeyCompressed } from '/root/free-money/freicoin-wallet/core/ecdsa.mjs';
import { frcLeg, claimReceived } from '/root/free-money/freicoin-wallet/core/swap.mjs';
import { paymentHashOf } from '/root/free-money/freicoin-wallet/core/htlc.mjs';
import { btcHtlcLeaf, btcHtlcAddress, btcHtlcClaim } from '/root/free-money/freicoin-wallet/core/btc.mjs';

const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const bin = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const mkrpc = (port, cookie, wallet) => { const a = Buffer.from(readFileSync(cookie)).toString('base64');
  return async (m, ...p) => { const r = await fetch(`http://127.0.0.1:${port}${wallet ? '/wallet/' + wallet : ''}`, { method: 'POST', headers: { Authorization: `Basic ${a}` }, body: JSON.stringify({ method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(`${m}: ${JSON.stringify(j.error)}`); return j.result; }; };
const frc = mkrpc(19660, '/root/nv3-playground/chain/regtest/.cookie', 'w');
const btc = mkrpc(38332, '/root/btc-signet/signet/.cookie', 'swap');

const kAlice = hex(sha256(bin('511ce'.padEnd(64, '0')))), kCarol = hex(sha256(bin('ca401'.padEnd(64, '0'))));
const pubA = pubkeyCompressed(kAlice), pubC = pubkeyCompressed(kCarol);
const R = hex(sha256(bin('signet-real-swap'.padEnd(64, '0')))), H = paymentHashOf(R);
const SWAP_BTC = 0.001;   // Alice buys 0.001 signet BTC

console.log('=== REAL FRC ↔ signet-BTC atomic swap ===');
console.log('signet tip:', await btc('getblockcount'), '| fc-nv3 tip:', await frc('getblockcount'), '| H =', H.slice(0, 16) + '…');

// 1. Alice funds the FRC HTLC on fc-nv3 (claim=Carol, refund=Alice)
const fH = await frc('getblockcount'), T1 = fH + 40;
const legF = frcLeg({ role: 'give', ourKey: kAlice, theirPub: pubC, paymentHash: H, cltv: T1, net: 'regtest' });
const fFund = await frc('sendtoaddress', legF.address, 0.005);
await frc('generatetoaddress', 1, await frc('getnewaddress'));
const fRaw = await frc('getrawtransaction', fFund, true);
const fVout = fRaw.vout.findIndex(o => o.scriptPubKey.hex === legF.spk);
const fVal = BigInt(Math.round(fRaw.vout[fVout].value * 1e8));
console.log(`1. Alice locked 0.005 FRC on fc-nv3 → ${fFund.slice(0, 12)}…:${fVout}  refund@${T1}`);

// 2. Carol funds the BTC HTLC on LIVE SIGNET (claim=Alice, refund=Carol, T2<T1)
const bH = await btc('getblockcount'), T2 = bH + 20;
const leafB = btcHtlcLeaf({ paymentHash: H, claimPub: pubA, refundPub: pubC, cltv: T2 });
const addrB = btcHtlcAddress(leafB, 'tb');   // signet hrp
const bFund = await btc('sendtoaddress', addrB, SWAP_BTC.toFixed(8));   // BROADCAST to real signet
const bRaw = await btc('getrawtransaction', bFund, true);
const bVout = bRaw.vout.findIndex(o => o.scriptPubKey.address === addrB);
const bVal = BigInt(Math.round(bRaw.vout[bVout].value * 1e8));
console.log(`2. Carol locked ${SWAP_BTC} BTC on SIGNET → ${bFund.slice(0, 12)}…:${bVout}  refund@${T2} (signet accepted it ✓)`);

// 3. Alice claims the signet BTC with R (spends the 0-conf HTLC) → R public on signet
const aliceAddr = await btc('getnewaddress', '', 'bech32');
const aliceSpk = (await btc('getaddressinfo', aliceAddr)).scriptPubKey;
const cB = btcHtlcClaim({ prevTxid: bFund, vout: bVout, valueSats: bVal, leafHex: leafB, preimage: R, claimKey: kAlice, toSpk: aliceSpk, fee: 2000n });
const cBid = await btc('sendrawtransaction', cB.rawtx);   // BROADCAST claim to real signet
console.log(`3. Alice claimed ${SWAP_BTC} BTC on SIGNET → ${cBid.slice(0, 12)}…  (signet accepted the HTLC claim ✓ — R now public)`);

// 4. Carol reads R from Alice's signet claim, claims the FRC on fc-nv3
const claim = await btc('getrawtransaction', cBid, true);
const learned = (claim.vin[0].txinwitness || []).find(w => w === R);
if (!learned) throw new Error('could not read R from the signet claim witness');
console.log(`4. Carol read R off the signet chain (matches ✓)`);
const carolAddr = await frc('getnewaddress');
const carolSpk = (await frc('getaddressinfo', carolAddr)).scriptPubKey;
const cF = claimReceived({ funding: { txid: fFund, vout: fVout, value: fVal, refheight: fRaw.lockheight }, leaf: legF.leaf, preimage: learned, ourKey: kCarol, toSpk: carolSpk, fee: 2000n });
await frc('generateblock', await frc('getnewaddress'), [cF.rawtx]);
console.log(`   Carol claimed 0.005 FRC on fc-nv3 → ${cF.txid.slice(0, 12)}…`);
console.log('\n✅ REAL CROSS-CHAIN SWAP COMPLETE — FRC ↔ genuine signet Bitcoin, no trusted third party.');
console.log(`   signet claim tx (verifiable on mempool.space/signet): ${cBid}`);
