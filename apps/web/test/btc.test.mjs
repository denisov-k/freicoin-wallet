// btc.test.mjs — the Bitcoin leg of a cross-chain swap: pure-function golden vectors, no
// daemon. The addresses/scripts here were cross-checked against a real bitcoin-core v28
// (validateaddress confirmed the HTLC P2WSH address and its witness program), and the full
// FRC↔BTC atomic swap ran end-to-end against a live bitcoind + fc-nv3 node — see
// research/lightning/swap_frc_btc.mjs. This locks the byte layout so it can't regress.
import { check, finish } from './helpers.mjs';
import { btcHtlcLeaf, btcHtlcSpk, btcHtlcAddress, btcAddress, btcTxid, bip143Sighash } from '../../../core/btc.mjs';

const H = 'df6b6e9f1e077f40'.padEnd(64, '0');
const claim = '02' + 'aa'.repeat(32), refund = '02' + 'bb'.repeat(32);
const leaf = btcHtlcLeaf({ paymentHash: H, claimPub: claim, refundPub: refund, cltv: 130 });

// Bitcoin dialect: CLTV keeps its arg → OP_DROP present (75); P2WSH program = single SHA256.
check('btc HTLC leaf byte layout',
  leaf === '63a820' + H + '88' + '21' + claim + '67' + '028200' + 'b1' + '75' + '21' + refund + '68ac');
check('btc leaf has OP_DROP after CLTV (Bitcoin, not Freicoin)', leaf.includes('b175'));
check('btc P2WSH spk = single SHA256 of the leaf',
  btcHtlcSpk(leaf) === '00201012c3a3cecc7ce88daef39c97a46d67d2e8ae4e8b0990e2509794cd62d1d859');

// classic bech32 (checksum const 1), NOT bech32m — validated by bitcoin-core validateaddress
check('btc HTLC address (classic bech32, bcrt)',
  btcHtlcAddress(leaf, 'bcrt') === 'bcrt1qzqfv8g7we37w3rdw7wwf0frdvlfw3tjw3vyepcjsj72v6ck3mpvsyqfz4z');
check('btc p2wpkh address (all-zero program)',
  btcAddress('00'.repeat(20), 'bcrt') === 'bcrt1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqdku202');

// BIP143 sighash is deterministic and has neither refheight nor lock_height (pure Bitcoin)
const tx = { version: 2, nLockTime: 0,
  vin: [{ prevout: { txid: 'ab'.repeat(32), vout: 0 }, scriptSig: '', sequence: 0xfffffffd, witness: [] }],
  vout: [{ value: 19998000n, scriptPubKey: '0014' + '11'.repeat(20) }] };
const sh1 = bip143Sighash(tx, 0, leaf, 20000000n);
const sh2 = bip143Sighash(tx, 0, leaf, 20000000n);
check('bip143 sighash is 32 bytes and deterministic', sh1.length === 64 && sh1 === sh2);
check('bip143 sighash changes with the amount', bip143Sighash(tx, 0, leaf, 20000001n) !== sh1);
check('btc txid is a 32-byte hex', btcTxid(tx).length === 64);

finish();
