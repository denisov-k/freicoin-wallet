// wallet.mjs — client-side wallet ops built on the core. Keys never leave here.
import { generateMnemonic as genM, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { derivePath, ckdPriv, wpkProgramHex } from '@core/hd.mjs';
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from '@core/sighash.mjs';
import { selectCoins } from '@core/coinselect.mjs';
import { serializeTx } from '@core/tx.mjs';
import { encodeWitness, decodeWitness } from '@core/address.mjs';
import { NETWORKS, DEFAULT_NET } from './netparams.mjs';

// The wallet targets one network at a time. NET / ACCOUNT (BIP84 m/84'/coinType'/0')
// follow the selected network; configureNetwork() switches them.
let NET = DEFAULT_NET;
let ACCOUNT = `m/84'/${NETWORKS[NET].coinType}'/0'`;
export function configureNetwork(net) {
  if (!NETWORKS[net]) throw new Error('unknown network ' + net);
  NET = net; ACCOUNT = `m/84'/${NETWORKS[net].coinType}'/0'`;
}
export const currentNet = () => NET;
const toKria = frc => BigInt(Math.round(frc * 1e8));

/** A fresh 12-word BIP39 mnemonic. */
export const generateMnemonic = () => genM(wordlist, 128);
export const isMnemonic = s => validateMnemonic(s.trim(), wordlist);

/** Resolve a stored secret (BIP39 mnemonic OR raw hex seed) to a hex BIP32 seed. */
export function resolveSecret(secret) {
  const s = (secret || '').trim();
  if (/\s/.test(s)) {
    if (!validateMnemonic(s, wordlist)) throw new Error('invalid recovery phrase');
    return Buffer.from(mnemonicToSeedSync(s)).toString('hex');
  }
  if (!/^[0-9a-fA-F]+$/.test(s)) throw new Error('enter a recovery phrase or hex seed');
  return s.toLowerCase();
}

/** The wallet's wpk scriptPubKeys (hex) over a gap limit on both chains — for the
 *  light client's BIP158 filter matching and block scan. */
export function walletScripts(seed, gap = 20) {
  const acct = derivePath(seed, ACCOUNT);
  const scripts = [];
  for (const chain of [0, 1]) {
    const c = ckdPriv(acct, chain);
    for (let i = 0; i < gap; i++) scripts.push('0014' + wpkProgramHex(ckdPriv(c, i)));
  }
  return scripts;
}

/** Validate a Freicoin address: correct bech32m + the expected HRP for the network. */
export function isValidAddress(addr, net = NET) {
  try {
    const { hrp } = decodeWitness((addr || '').trim());
    return hrp === NETWORKS[net]?.hrp;
  } catch { return false; }
}

/** A receive (chain 0) or change (chain 1) address at index. */
export function deriveAddress(seed, index = 0, chain = 0) {
  return encodeWitness(NET, 0, wpkProgramHex(derivePath(seed, `${ACCOUNT}/${chain}/${index}`)));
}

// scriptPubKey (hex) of a Freicoin witness-v0 address
export function addrToSpk(addr) {
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
