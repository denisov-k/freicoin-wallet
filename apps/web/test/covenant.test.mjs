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

console.log(`\nOK ✅  (${pass} checks)`);
