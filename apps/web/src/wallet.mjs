// wallet.mjs — client-side wallet ops built on the core. Keys never leave here.
import { derivePath, ckdPriv, wpkProgramHex } from '../../../core/hd.mjs';
import { pubkeyCompressed, signEcdsa } from '../../../core/ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from '../../../core/sighash.mjs';
import { selectCoins } from '../../../core/coinselect.mjs';
import { serializeTx } from '../../../core/tx.mjs';
import { encodeWitness, decodeWitness } from '../../../core/address.mjs';

// regtest account (coin type 1). Mainnet would be m/84'/0'/0' with 'main' HRP.
export const ACCOUNT = "m/84'/1'/0'";
export const NET = 'regtest';
const toKria = frc => BigInt(Math.round(frc * 1e8));

/** A receive (chain 0) or change (chain 1) address at index. */
export function deriveAddress(seed, index = 0, chain = 0) {
  return encodeWitness(NET, 0, wpkProgramHex(derivePath(seed, `${ACCOUNT}/${chain}/${index}`)));
}

// scriptPubKey (hex) of a Freicoin witness-v0 address
function addrToSpk(addr) {
  const { version, programHex } = decodeWitness(addr);
  return version.toString(16).padStart(2, '0') + (programHex.length / 2).toString(16).padStart(2, '0') + programHex;
}

// map every derived wpk scriptPubKey -> its key node, over a gap limit. Derive the
// account node once and CKD its children (the core's pure-JS secp256k1 is correct
// but slow; a browser build should alias ecdsa's point-mul to @noble like crypto).
function keyMap(seed, gap = 20) {
  const acct = derivePath(seed, ACCOUNT);
  const m = {};
  for (const chain of [0, 1]) {
    const chainNode = ckdPriv(acct, chain);
    for (let i = 0; i < gap; i++) {
      const node = ckdPriv(chainNode, i);
      m['0014' + wpkProgramHex(node)] = node;
    }
  }
  return m;
}

/**
 * Build a fully-signed transaction paying `toAddress` `amountFrc`, with change back
 * to the wallet. Uses refheight-aware coin selection at lock_height = tipHeight.
 * Returns { rawtx, fee, change, inputs }.
 */
export function buildSignedTx({ seed, utxos, toAddress, amountFrc, tipHeight, feerate = 1n }) {
  const km = keyMap(seed);
  const target = toKria(amountFrc);
  const COINBASE_MATURITY = 100;   // coinbase outputs are unspendable until 100 deep
  const spendable = utxos.filter(u => !u.coinbase || tipHeight - u.refheight >= COINBASE_MATURITY);
  const sel = selectCoins(
    spendable.map(u => ({ value: toKria(u.nominal), refheight: u.refheight, _u: u })),
    target, BigInt(feerate), tipHeight,
  );
  const changeProg = wpkProgramHex(derivePath(seed, `${ACCOUNT}/1/0`));
  const vout = [{ value: target, scriptPubKey: addrToSpk(toAddress) }];
  if (sel.change > 0n) vout.push({ value: sel.change, scriptPubKey: '0014' + changeProg });

  const tx = {
    version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: tipHeight,
    vin: sel.selected.map(s => ({
      prevout: { txid: s._u.txid.match(/../g).reverse().join(''), vout: s._u.vout },
      scriptSig: '', sequence: 0xffffffff, witness: [],
    })),
    vout,
  };
  // sign each input (wpk MAST): witness = [sig+hashtype, 0x00||p2pk, empty proof]
  sel.selected.forEach((s, i) => {
    const node = km[s._u.scriptPubKey];
    if (!node) throw new Error('no key for input ' + s._u.txid);
    const secret = node.priv.toString(16).padStart(64, '0');
    const scriptCode = '21' + pubkeyCompressed(secret) + 'ac';
    const sh = segwitV0Sighash(tx, i, scriptCode, toKria(s._u.nominal), s._u.refheight, SIGHASH_ALL);
    tx.vin[i].witness = [signEcdsa(secret, sh) + '01', '00' + scriptCode, ''];
  });
  return { rawtx: serializeTx(tx), fee: sel.fee, change: sel.change, inputs: sel.selected.length };
}
