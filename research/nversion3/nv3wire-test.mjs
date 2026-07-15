// nv3wire-test.mjs — the extension-output wire binding driven through the REAL Nv3State:
// issuance/transfer/inflation with spk-derived tags, token commitment+reveal, forgery negatives.
import { Nv3State } from '../../core/nv3chain.mjs';
import { bindNv3Tx, makeTokenReveal } from '../../core/nv3wire.mjs';
import { encodeAssetSpk, tokenSetHash } from '../../core/asset-spk.mjs';
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

// 6) TWO-SIDED reveal: SPEND a token-bearing coin. The chainstate holds only the commitment, so
//    the spender reveals the INPUT tokens (checked vs the coin's commitment) AND the OUTPUT tokens.
const st4 = new Nv3State();
st4.assets.set(tag2, { k: 64, interest: true, granularity: 1 });
const held = ['cafe01', 'cafe02'];
st4.seed('tk0', 0, { assetId: tag2, value: 2n, refheight: 100, scriptPubKey: alice, tokenCommit: tokenSetHash(held) });
const xoOuts = [{ value: 2n, scriptPubKey: encodeAssetSpk(bob, tag2, held), tokens: held }];
const xoReveal = makeTokenReveal(xoOuts, [{ tokens: held }]);   // output section + input section
const xferTok = { txid: 'c1'.repeat(32), lockHeight: 100, inputs: ['tk0:0'],
  wireOuts: [xoOuts[0], { value: 0n, scriptPubKey: opret(xoReveal) }] };
const b6 = bindNv3Tx(xferTok);
t(b6.ok && JSON.stringify(b6.tx.inputReveals) === JSON.stringify([held]), 'input reveal attached: ' + (b6.err || ''));
const r6 = st4.apply(b6.tx);
t(r6.ok, 'token transfer with two-sided reveal applies: ' + (r6.err || ''));
t(st4.utxos.get('c1'.repeat(32) + ':0')?.tokenCommit === tokenSetHash(held) && !st4.utxos.get('c1'.repeat(32) + ':0')?.tokens,
  'new coin stores commitment only (no token list)');

// 7) input commitment WITHOUT reveal → rejected by the state machine
const st5 = new Nv3State();
st5.assets.set(tag2, { k: 64, interest: true, granularity: 1 });
st5.seed('tk1', 0, { assetId: tag2, value: 2n, refheight: 100, scriptPubKey: alice, tokenCommit: tokenSetHash(held) });
const noReveal = { txid: 'c2'.repeat(32), lockHeight: 100, inputs: ['tk1:0'],
  wireOuts: [{ value: 2n, scriptPubKey: encodeAssetSpk(bob, tag2, held), tokens: held }, { value: 0n, scriptPubKey: opret(makeTokenReveal(xoOuts)) }] };
const b7 = bindNv3Tx(noReveal); const r7 = b7.ok ? st5.check(b7.tx) : { ok: false };
t(b7.ok && !r7.ok && /commitment without reveal/.test(r7.err || ''), 'input commitment w/o reveal rejected: ' + (r7.err || ''));

// 8) input reveal that DOESN'T match the coin's commitment → rejected
const st6 = new Nv3State();
st6.assets.set(tag2, { k: 64, interest: true, granularity: 1 });
st6.seed('tk2', 0, { assetId: tag2, value: 2n, refheight: 100, scriptPubKey: alice, tokenCommit: tokenSetHash(held) });
const wrongIn = makeTokenReveal(xoOuts, [{ tokens: ['deadbeef99'] }]);
const badIn = { txid: 'c3'.repeat(32), lockHeight: 100, inputs: ['tk2:0'],
  wireOuts: [xoOuts[0], { value: 0n, scriptPubKey: opret(wrongIn) }] };
const b8 = bindNv3Tx(badIn); const r8 = b8.ok ? st6.check(b8.tx) : { ok: false };
t(b8.ok && !r8.ok && /does not match commitment/.test(r8.err || ''), 'mismatched input reveal rejected: ' + (r8.err || ''));

// 9) input reveal for a coin that carries NO commitment → rejected
const st7 = new Nv3State();
st7.assets.set(tag2, { k: 64, interest: true, granularity: 1 });
st7.seed('tk3', 0, { assetId: tag2, value: 2n, refheight: 100, scriptPubKey: alice });   // no tokenCommit
const strayIn = makeTokenReveal([], [{ tokens: ['cafe01'] }]);
const badStray = { txid: 'c4'.repeat(32), lockHeight: 100, inputs: ['tk3:0'],
  wireOuts: [{ value: 2n, scriptPubKey: encodeAssetSpk(bob, tag2) }, { value: 0n, scriptPubKey: opret(strayIn) }] };
const b9 = bindNv3Tx(badStray); const r9 = b9.ok ? st7.check(b9.tx) : { ok: false };
t(b9.ok && !r9.ok && /reveal without commitment/.test(r9.err || ''), 'stray input reveal rejected: ' + (r9.err || ''));

console.log(fail ? 'FAILURES: ' + fail : 'ALL ' + ok + ' PASS');
process.exit(fail ? 1 : 0);
