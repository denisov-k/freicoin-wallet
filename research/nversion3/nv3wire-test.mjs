// nv3wire-test.mjs — the extension-output wire binding driven through the REAL Nv3State:
// issuance/transfer/inflation with spk-derived tags, token commitment+reveal, forgery negatives.
import { Nv3State } from '../../core/nv3chain.mjs';
import { bindNv3Tx, makeTokenReveal } from '../../core/nv3wire.mjs';
import { encodeAssetSpk } from '../../core/asset-spk.mjs';
import { assetIdOf, FRC } from '../../core/assets.mjs';

let ok = 0, fail = 0;
const t = (cond, m) => { cond ? ok++ : (fail++, console.log('FAIL:', m)); };
const opret = payload => '6a' + (payload.length / 2).toString(16).padStart(2, '0') + payload;

const st = new Nv3State();
const alice = '0014' + 'aa'.repeat(20), bob = '0014' + 'bb'.repeat(20);
st.seed('coin0', 0, { assetId: FRC, value: 100000000n, refheight: 100, scriptPubKey: alice });

// 1) issuance as a STANDARD v2 tx — tag in the mint output's extension push
const def = { k: 64, interest: true, granularity: 1 };
const tag = assetIdOf(def);
const issue = { txid: 'a1'.repeat(32), lockHeight: 100, inputs: ['coin0:0'], def,
  wireOuts: [
    { value: 1000n, scriptPubKey: encodeAssetSpk(alice, tag) },
    { value: 99990000n, scriptPubKey: alice },
  ] };
const b1 = bindNv3Tx(issue);
t(b1.ok, 'issuance binds: ' + (b1.err || ''));
t(b1.ok && b1.tx.outputs[0].assetId === tag && b1.tx.outputs[1].assetId === FRC, 'tags derived from spk');
const r1 = st.apply(b1.tx);
t(r1.ok && r1.fee === 10000n, 'issuance applies, fee 10000: ' + (r1.err || r1.fee));

// 2) transfer
const xfer = { txid: 'a2'.repeat(32), lockHeight: 100, inputs: [('a1'.repeat(32)) + ':0', ('a1'.repeat(32)) + ':1'],
  wireOuts: [
    { value: 400n, scriptPubKey: encodeAssetSpk(bob, tag) },
    { value: 600n, scriptPubKey: encodeAssetSpk(alice, tag) },
    { value: 99980000n, scriptPubKey: alice },
  ] };
const b2 = bindNv3Tx(xfer); const r2 = st.apply(b2.tx);
t(b2.ok && r2.ok, 'transfer ok: ' + (b2.err || r2.err || ''));

// 3) inflation attempt still caught by the unchanged state machine
const inflate = { txid: 'a3'.repeat(32), lockHeight: 100, inputs: [('a2'.repeat(32)) + ':0'],
  wireOuts: [{ value: 500n, scriptPubKey: encodeAssetSpk(bob, tag) }] };
const b3 = bindNv3Tx(inflate); const r3 = st.check(b3.tx);
t(b3.ok && !r3.ok && /inflated|conserved/.test(r3.err), 'inflation rejected: ' + (r3.err || ''));

// 4) tokens: 52-byte commitment + FRT1 reveal
const toks = ['deadbeef01', 'deadbeef02'];
const st2 = new Nv3State();
st2.seed('c1', 0, { assetId: FRC, value: 50000n, refheight: 100, scriptPubKey: alice });
const def2 = { k: 64, interest: true, granularity: 1 };
const tag2 = assetIdOf(def2);
const outs = [{ value: 2n, scriptPubKey: encodeAssetSpk(alice, tag2, toks), tokens: toks }, { value: 40000n, scriptPubKey: alice }];
const reveal = makeTokenReveal(outs);
const mint2 = { txid: 'b1'.repeat(32), lockHeight: 100, inputs: ['c1:0'], def: def2,
  wireOuts: [outs[0], outs[1], { value: 0n, scriptPubKey: opret(reveal) }] };
const b4 = bindNv3Tx(mint2);
t(b4.ok, 'token mint binds: ' + (b4.err || ''));
t(b4.ok && JSON.stringify(b4.tx.outputs[0].tokens) === JSON.stringify(toks), 'tokens bound from reveal');
const r4 = st2.apply(b4.tx);
t(r4.ok, 'token mint applies: ' + (r4.err || ''));

// 5) negatives on commitment/reveal machinery
const bad1 = { txid: 'b2'.repeat(32), lockHeight: 100, inputs: [('b1'.repeat(32)) + ':1'],
  wireOuts: [{ value: 2n, scriptPubKey: encodeAssetSpk(alice, tag2, toks) }] };
t(!bindNv3Tx(bad1).ok, 'commitment w/o reveal rejected');

const wrongReveal = makeTokenReveal([{ tokens: ['ffff'] }]);
const bad2 = { txid: 'b3'.repeat(32), lockHeight: 100, inputs: [('b1'.repeat(32)) + ':1'],
  wireOuts: [{ value: 2n, scriptPubKey: encodeAssetSpk(alice, tag2, toks) }, { value: 0n, scriptPubKey: opret(wrongReveal) }] };
t(/does not match/.test(bindNv3Tx(bad2).err || ''), 'mismatched reveal rejected');

const stray = makeTokenReveal([{ tokens: ['aaaa'] }]);
const bad3 = { txid: 'b4'.repeat(32), lockHeight: 100, inputs: [('b1'.repeat(32)) + ':1'],
  wireOuts: [{ value: 2n, scriptPubKey: encodeAssetSpk(alice, tag2) }, { value: 0n, scriptPubKey: opret(stray) }] };
t(/without commitment/.test(bindNv3Tx(bad3).err || ''), 'stray reveal rejected');

// 5d) token forgery: valid binding, but the STATE machine rejects tokens minted from nothing
const st3 = new Nv3State();
st3.seed('c2', 0, { assetId: tag2, value: 2n, refheight: 100, scriptPubKey: alice });
st3.assets.set(tag2, { k: 64, interest: true, granularity: 1 });
const forgeOuts = [{ value: 2n, scriptPubKey: encodeAssetSpk(bob, tag2, toks), tokens: toks }];
const forgeReveal = makeTokenReveal(forgeOuts);
const forge = { txid: 'b5'.repeat(32), lockHeight: 100, inputs: ['c2:0'],
  wireOuts: [forgeOuts[0], { value: 0n, scriptPubKey: opret(forgeReveal) }] };
const bf = bindNv3Tx(forge);
const rf = bf.ok ? st3.check(bf.tx) : { ok: false, err: 'binding failed: ' + bf.err };
t(bf.ok && !rf.ok && /created from nothing/.test(rf.err), 'token forgery rejected by state machine: ' + (rf.err || ''));

console.log(fail ? 'FAILURES: ' + fail : 'ALL ' + ok + ' PASS');
process.exit(fail ? 1 : 0);
