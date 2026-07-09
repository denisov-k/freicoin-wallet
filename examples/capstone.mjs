// capstone.mjs — build a fully-signed Freicoin tx entirely in JS from the wallet
// core stones, spending a wpk (MAST) coinbase output. Prints the raw tx hex for
// the node to accept via sendrawtransaction. Args: <utxo_txid> <vout> <nominal_kria>
import { derivePath, pubkey, wpkProgramHex } from '../core/hd.mjs';
import { pubkeyCompressed } from '../core/ecdsa.mjs';
import { signEcdsa } from '../core/ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from '../core/sighash.mjs';
import { serializeTx } from '../core/tx.mjs';

const SEED = '000102030405060708090a0b0c0d0e0f';
const [utxoTxid, voutStr, nominalStr] = process.argv.slice(2);
const vout = parseInt(voutStr, 10);
const nominal = BigInt(nominalStr);          // input coin nominal value (kria)
const REFHEIGHT = 1;                          // coinbase from block 1
const LOCK_HEIGHT = REFHEIGHT;                // distance 0 => present value == nominal
const FEE = 10000n;                           // kria

const node0 = derivePath(SEED, "m/84'/1'/0'/0/0");
const secretHex = node0.priv.toString(16).padStart(64, '0');
const pubHex = pubkeyCompressed(secretHex);
const scriptCode = '21' + pubHex + 'ac';      // <pubkey> OP_CHECKSIG (the executed p2pk)
const progOut = wpkProgramHex(derivePath(SEED, "m/84'/1'/0'/0/1"));  // pay change to index 1

const txidInternal = utxoTxid.match(/../g).reverse().join('');       // display -> internal order
const tx = {
  version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: LOCK_HEIGHT,
  vin: [{ prevout: { txid: txidInternal, vout }, scriptSig: '', sequence: 0xffffffff, witness: [] }],
  vout: [{ value: nominal - FEE, scriptPubKey: '0014' + progOut }],
};

// sign input 0 (wpk): segwitV0 sighash over the p2pk scriptCode, ECDSA, then the
// MAST witness stack [<sig+hashtype>, <0x00||p2pk>, <empty proof>].
const sighash = segwitV0Sighash(tx, 0, scriptCode, nominal, REFHEIGHT, SIGHASH_ALL);
const sig = signEcdsa(secretHex, sighash) + '01';                    // + SIGHASH_ALL byte
tx.vin[0].witness = [sig, '00' + scriptCode, ''];                    // proof empty (no branch)

console.error(`input ${utxoTxid}:${vout} nominal=${nominal} -> out ${nominal - FEE} fee=${FEE} lock_height=${LOCK_HEIGHT}`);
console.log(serializeTx(tx));
