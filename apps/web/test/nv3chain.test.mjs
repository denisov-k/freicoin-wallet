// nVersion=3-lite consensus state-transition model: exercise the UTXO-set machine the way
// ConnectBlock/CheckTxInputs will in the node — issuance, per-asset conservation across a
// chain of txs, double-spend & inflation rejection, FRC fees, and per-asset demurrage over time.
import { check, finish } from './helpers.mjs';
import { FRC, assetIdOf, assetPresentValue } from '../../../core/assets.mjs';
import { Nv3State, approvalDigest } from '../../../core/nv3chain.mjs';
import { pubkeyCompressed, signEcdsa } from '../../../core/ecdsa.mjs';

const st = new Nv3State();
const spk = t => '0014' + t.repeat(20);

// seed FRC coinbase funds for fees
const frc0 = st.seed('cb', 0, { assetId: FRC, value: 100000000n, refheight: 1000, scriptPubKey: spk('11') });

// 1. issue a community currency (k=18), minting 100 units; FRC pays the fee
const coop = { k: 18, interest: false, granularity: 1 };
const idCoop = assetIdOf(coop);
const iss = st.apply({
  txid: 'iss', lockHeight: 1000, def: coop,
  inputs: [frc0],
  outputs: [
    { assetId: idCoop, value: 10000000000n, scriptPubKey: spk('22') },   // 100 units minted
    { assetId: FRC, value: 99998000n, scriptPubKey: spk('11') },          // FRC change
  ],
});
check('issuance applies: asset registered + minted, FRC fee taken', iss.ok && st.assets.has(idCoop) && iss.fee === 2000n, `fee ${iss.fee}`);
check('minted coop is now a spendable UTXO', st.utxos.has('iss:0'));

// 2. transfer the coop 500 blocks later — conserves present value; melts vs nominal
const aged = assetPresentValue(10000000000n, 500, coop);
const xfer = st.apply({
  txid: 'x1', lockHeight: 1500,
  inputs: ['iss:0'],
  outputs: [{ assetId: idCoop, value: aged, scriptPubKey: spk('33') }],
});
check('coop transfer conserves present value at the new lock_height', xfer.ok, `${aged} kria present`);
check('spent input is gone from the UTXO set', !st.utxos.has('iss:0') && st.utxos.has('x1:0'));

// 3. double-spend of the same input is rejected
const dbl = st.apply({ txid: 'x1b', lockHeight: 1500, inputs: ['iss:0'], outputs: [{ assetId: idCoop, value: 1n, scriptPubKey: spk('44') }] });
check('double-spend rejected (input already spent)', !dbl.ok);

// 4. inflation is rejected: try to output the full nominal from the melted coin
const inflate = st.check({ txid: 'bad', lockHeight: 2000, inputs: ['x1:0'], outputs: [{ assetId: idCoop, value: 10000000000n, scriptPubKey: spk('55') }] });
check('inflation rejected (output > input present value)', !inflate.ok);

// 5. unknown asset cannot be moved
st.seed('u', 0, { assetId: 'ab'.repeat(20), value: 5n, refheight: 1000, scriptPubKey: spk('66') });
check('unknown asset rejected', !st.check({ txid: 'u1', lockHeight: 1001, inputs: ['u:0'], outputs: [] }).ok);

// 6. per-asset demurrage invariant: coop supply present value strictly decreases with height
const s1500 = st.supplyPresentValue(idCoop, 1500), s6500 = st.supplyPresentValue(idCoop, 6500);
check('coop supply melts over time (demurrage invariant)', s6500 < s1500 && s1500 > 0n, `1500→${s1500} kria, 6500→${s6500} kria`);

// 7. an INTEREST asset (bond) grows: output nominal may exceed input over time
const st2 = new Nv3State();
const f2 = st2.seed('cb2', 0, { assetId: FRC, value: 10000000n, refheight: 1000, scriptPubKey: spk('11') });
const bond = { k: 18, interest: true, granularity: 1 };
const idBond = assetIdOf(bond);
st2.apply({ txid: 'ib', lockHeight: 1000, def: bond, inputs: [f2],
  outputs: [{ assetId: idBond, value: 1000000000n, scriptPubKey: spk('77') }, { assetId: FRC, value: 9998000n, scriptPubKey: spk('11') }] });
const grown = assetPresentValue(1000000000n, 500, bond);
const bx = st2.apply({ txid: 'bx', lockHeight: 1500, inputs: ['ib:0'], outputs: [{ assetId: idBond, value: grown, scriptPubKey: spk('88') }] });
check('interest asset (bond) lets output nominal exceed the minted input', bx.ok && grown > 1000000000n, `grew to ${grown}`);

// 8. granularity: an asset with a min unit rejects non-multiple outputs
const st3 = new Nv3State();
const f3 = st3.seed('cb3', 0, { assetId: FRC, value: 10000000n, refheight: 1000, scriptPubKey: spk('11') });
const shares = { k: 20, interest: false, granularity: 100 };   // indivisible below 100 kria (whole "shares")
const idSh = assetIdOf(shares);
st3.apply({ txid: 'is', lockHeight: 1000, def: shares, inputs: [f3],
  outputs: [{ assetId: idSh, value: 1000n, scriptPubKey: spk('99') }, { assetId: FRC, value: 9998000n, scriptPubKey: spk('11') }] });
const okGran = st3.check({ txid: 'g1', lockHeight: 1000, inputs: ['is:0'], outputs: [{ assetId: idSh, value: 900n, scriptPubKey: spk('aa') }, { assetId: idSh, value: 100n, scriptPubKey: spk('bb') }] });
const badGran = st3.check({ txid: 'g2', lockHeight: 1000, inputs: ['is:0'], outputs: [{ assetId: idSh, value: 950n, scriptPubKey: spk('aa') }, { assetId: idSh, value: 50n, scriptPubKey: spk('bb') }] });
check('granularity: multiple-of-unit outputs accepted', okGran.ok);
check('granularity: non-multiple output rejected', !badGran.ok);

// 9. unique tokens (smart property): mint a token with an asset, transfer it, conserve it
const st4 = new Nv3State();
const fT = st4.seed('cbT', 0, { assetId: FRC, value: 10000000n, refheight: 1000, scriptPubKey: spk('11') });
const collectible = { k: 20, interest: false, granularity: 1 };
const idC = assetIdOf(collectible);
// issuance mints token 'deadbeef' of the new asset (value 0 — a pure token) + FRC change
const issT = st4.apply({ txid: 'mintok', lockHeight: 1000, def: collectible, inputs: [fT],
  outputs: [{ assetId: idC, value: 0n, scriptPubKey: spk('a1'), tokens: ['deadbeef'] }, { assetId: FRC, value: 9998000n, scriptPubKey: spk('11') }] });
check('token minted at issuance', issT.ok && st4.utxos.get('mintok:0').tokens[0] === 'deadbeef');
// transfer the token to a new output — must be conserved (present in an input)
const xferT = st4.apply({ txid: 'movtok', lockHeight: 1001, inputs: ['mintok:0'],
  outputs: [{ assetId: idC, value: 0n, scriptPubKey: spk('a2'), tokens: ['deadbeef'] }] });
check('token transferred (conserved from an input)', xferT.ok && st4.utxos.get('movtok:0').tokens[0] === 'deadbeef');
// creating a token from nothing is rejected
const forge = st4.check({ txid: 'forge', lockHeight: 1002, inputs: ['movtok:0'],
  outputs: [{ assetId: idC, value: 0n, scriptPubKey: spk('a3'), tokens: ['cafe1234'] }] });
check('cannot create a token from nothing', !forge.ok);
// duplicating a token across two outputs is rejected
const dup = st4.check({ txid: 'dup', lockHeight: 1002, inputs: ['movtok:0'],
  outputs: [{ assetId: idC, value: 0n, scriptPubKey: spk('a4'), tokens: ['deadbeef'] }, { assetId: idC, value: 0n, scriptPubKey: spk('a5'), tokens: ['deadbeef'] }] });
check('cannot output the same token twice (uniqueness)', !dup.ok);

// 10. nExpireTime: a tx is rejected once the chain passes its expiry height
const st5 = new Nv3State();
const fE = st5.seed('cbE', 0, { assetId: FRC, value: 10000000n, refheight: 1000, scriptPubKey: spk('11') });
const okExp = st5.check({ txid: 'e1', lockHeight: 1000, nExpireTime: 1005, inputs: ['cbE:0'],
  outputs: [{ assetId: FRC, value: 9998000n, scriptPubKey: spk('22') }] }, 1004);
const badExp = st5.check({ txid: 'e2', lockHeight: 1000, nExpireTime: 1005, inputs: ['cbE:0'],
  outputs: [{ assetId: FRC, value: 9998000n, scriptPubKey: spk('22') }] }, 1006);
check('nExpireTime: valid before expiry', okExp.ok);
check('nExpireTime: rejected after expiry', !badExp.ok);

// 11. authorizers: moving an authorized asset requires the authorizer's REAL ECDSA signature
// over approvalDigest(txid, tag); a wrong key or a sig for another tx must be rejected.
const st6 = new Nv3State();
const fA = st6.seed('cbA', 0, { assetId: FRC, value: 10000000n, refheight: 1000, scriptPubKey: spk('11') });
const AUTH_SECRET = '11'.repeat(32);
const AUTH = pubkeyCompressed(AUTH_SECRET);
const stock = { k: 20, interest: false, granularity: 1, authorizer: AUTH };
const idS = assetIdOf(stock);
st6.apply({ txid: 'defstock', lockHeight: 1000, def: stock, inputs: [fA],
  outputs: [{ assetId: idS, value: 1000n, scriptPubKey: spk('c1') }, { assetId: FRC, value: 9998000n, scriptPubKey: spk('11') }] });
const stockOut = [{ assetId: idS, value: 1000n, scriptPubKey: spk('c2') }];
const noApproval = st6.check({ txid: 's1', lockHeight: 1000, inputs: ['defstock:0'], outputs: stockOut });
const goodSig = signEcdsa(AUTH_SECRET, approvalDigest('s2', idS));
const withApproval = st6.check({ txid: 's2', lockHeight: 1000, inputs: ['defstock:0'], outputs: stockOut,
  approvals: [{ assetId: idS, sig: goodSig }] });
const wrongTx = st6.check({ txid: 's3', lockHeight: 1000, inputs: ['defstock:0'], outputs: stockOut,
  approvals: [{ assetId: idS, sig: goodSig }] });   // sig binds txid s2, tx is s3
const wrongKey = st6.check({ txid: 's4', lockHeight: 1000, inputs: ['defstock:0'], outputs: stockOut,
  approvals: [{ assetId: idS, sig: signEcdsa('22'.repeat(32), approvalDigest('s4', idS)) }] });
check('authorizer: transfer rejected without approval', !noApproval.ok);
check('authorizer: transfer accepted with a valid signature', withApproval.ok);
check('authorizer: signature for another tx rejected', !wrongTx.ok);
check('authorizer: signature by another key rejected', !wrongKey.ok);
check('authorizer is committed in the asset id', idS !== assetIdOf({ k: 20, interest: false, granularity: 1 }));

finish();
