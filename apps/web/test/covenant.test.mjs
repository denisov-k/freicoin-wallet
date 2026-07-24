// covenant.test.mjs — pure-JS unit tests for core/covenant.mjs (the Harberger covenant client
// builders/reader). The end-to-end proof that the builders produce node-accepted txs lives in
// research/covenant-e2e-regtest.mjs; here we check the pure functions.
//   node --import ./apps/web/test/register-aliases.mjs apps/web/test/covenant.test.mjs
import assert from 'node:assert';
import { nameHashOf, ownerHashOf, covenantSpk, readCovenant, covenantPrice } from '@core/covenant.mjs';
import { encodeHarbergerSpk } from '@core/asset-spk.mjs';
import { frcWpkSpk } from '@core/freiland.mjs';
import { pubkeyCompressed } from '@core/ecdsa.mjs';
import { assetPresentValue } from '@core/assets.mjs';
import { parseTx, serializeTx } from '@core/tx.mjs';
import { sha256 } from '@core/crypto.mjs';
import { Buffer } from 'buffer';

let pass = 0; const check = (n, c) => { assert.ok(c, n); console.log('PASS ', n); pass++; };

const pub = pubkeyCompressed(sha256(Buffer.from('owner-key', 'utf8')).toString('hex'));

// nameHash is deterministic and = sha256(utf8 name)
check('nameHashOf is sha256(utf8 name)', nameHashOf('alice.frl') === sha256(Buffer.from('alice.frl', 'utf8')).toString('hex'));
check('nameHashOf is deterministic', nameHashOf('x') === nameHashOf('x') && nameHashOf('x') !== nameHashOf('y'));

// owner commitment = the owner's wpk program, so the payout 0014{owner} is their own address
check('ownerHashOf = wpk program of the pubkey', ownerHashOf(pub) === frcWpkSpk(pub).slice(4));
check('owner is 20 bytes', ownerHashOf(pub).length === 40);

// covenantSpk == the raw HRBG wire bytes for (nameHash, owner, floorV)
const spk = covenantSpk('alice.frl', pub, 1000000);
check('covenantSpk == encodeHarbergerSpk(nameHash, owner, floorV)',
  spk === encodeHarbergerSpk(nameHashOf('alice.frl'), ownerHashOf(pub), 1000000));

// readCovenant round-trips covenantSpk
const r = readCovenant(spk);
check('readCovenant nameHash round-trips', r && r.nameHash === nameHashOf('alice.frl'));
check('readCovenant owner round-trips', r.owner === ownerHashOf(pub));
check('readCovenant floorV round-trips as BigInt', r.floorV === 1000000n);
check('readCovenant returns null for a non-covenant spk', readCovenant('0014' + '11'.repeat(20)) === null);

// covenantPrice == asset_pv (host demurrage, shift 20) at the given distance
const D = 100000000n, refh = 1000, h = 4202;
check('covenantPrice == assetPresentValue(deposit, distance, host)',
  covenantPrice(D, refh, h) === assetPresentValue(D, h - refh, { k: 20, interest: false }));
check('price drifts below the deposit as it melts', covenantPrice(D, refh, h) < D);
check('price == deposit at distance 0 (fresh)', covenantPrice(D, refh, refh) === D);

// REGRESSION (2026-07-24): a tx carrying a real 65-byte HARBERGER covenant output
// (51 20{nameHash} 14{owner} 08{floorV} 53) must survive parseTx→serializeTx BYTE-FOR-BYTE.
// decodeAssetSpk folded it to the 34-byte baseSpk, so serializeTx re-emitted a shorter script and
// scan.mjs parseBlock's `hex.slice(serializeTx(tx).length)` desynced on the block holding a
// claim/buy tx — the only block a claiming wallet downloads — freezing its sync at "reconnecting".
const CLAIM_TX = '03000080ff0101406e2852c98c52f55b2c093f8e9c47a8b5eac1ad87892df41e7f93dbe80361b90100000000ffffffff02f8599b5402000000415120b3ec1fd024c36fcedb7fe8fd61351c7c42224faeca726e0ff5df2357ac1afad21410639dd513b64d951a3345a231e56a8dbef42a2d0840420f0000000000530af4791701000000160014ab1c72425eb8372e59acb1a9e4ceeae4dcc3b13a000003483045022100c380e16be23b47c33e152f719534e904e3f0184f2ed53995a9a8f14412552e5402207bcab14f7a56a9b1c54ecad70bd6acc230a237e954d048c2b003af97883832770124002102aa5fe987343a470332c2acc379166b3b151c02c40692ba68e6050d2fa72dd1eeac00000000008d04000000000000';
check('covenant claim tx round-trips through parseTx/serializeTx', serializeTx(parseTx(CLAIM_TX)) === CLAIM_TX);
const dvout = parseTx(CLAIM_TX).vout[0];
check('covenant output keeps its full 65-byte script (not folded to baseSpk)', dvout.scriptPubKey.length === 130 && dvout.assetTag === null);

console.log(`\nOK ✅  (${pass} checks)`);
