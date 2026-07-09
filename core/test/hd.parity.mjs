// Validate hd.mjs against the canonical BIP32 Test Vector 1 (authoritative, no
// node). Freicoin uses Bitcoin's ext-key version bytes, so these apply directly.
//   node hd.parity.mjs
import { fromSeed, ckdPriv, derivePath, toXprv, toXpub, wpkProgramHex } from '../hd.mjs';
import { encodeWitness } from '../address.mjs';

const SEED = '000102030405060708090a0b0c0d0e0f';
const HARD = 0x80000000;

// (path, expected xprv, expected xpub) from BIP32 Test Vector 1
const VEC = [
  ['m',
   'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
   'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8'],
  ["m/0'",
   'xprv9uHRZZhk6KAJC1avXpDAp4MDc3sQKNxDiPvvkX8Br5ngLNv1TxvUxt4cV1rGL5hj6KCesnDYUhd7oWgT11eZG7XnxHrnYeSvkzY7d2bhkJ7',
   'xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw'],
  ["m/0'/1",
   'xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs',
   'xpub6ASuArnXKPbfEwhqN6e3mwBcDTgzisQN1wXN9BJcM47sSikHjJf3UFHKkNAWbWMiGj7Wf5uMash7SyYq527Hqck2AxYysAA7xmALppuCkwQ'],
];

let ok = 0, fail = 0, firstfail = null;
const check = (cond, label, extra) => { if (cond) ok++; else { fail++; if (!firstfail) firstfail = { label, ...extra }; } };

for (const [path, xprv, xpub] of VEC) {
  const node = derivePath(SEED, path);
  const gx = toXprv(node), gp = toXpub(node);
  check(gx === xprv, `${path} xprv`, { got: gx, want: xprv });
  check(gp === xpub, `${path} xpub`, { got: gp, want: xpub });
}

// derivePath and step-by-step ckdPriv must agree
const a = derivePath(SEED, "m/0'/1");
let b = ckdPriv(ckdPriv(fromSeed(SEED), 0 + HARD), 1);
check(toXprv(a) === toXprv(b), 'path==manual', {});

// hardened vs normal actually differ
check(toXprv(ckdPriv(fromSeed(SEED), 0)) !== toXprv(ckdPriv(fromSeed(SEED), 0 + HARD)), 'hardened_differs', {});

// HD -> Freicoin wpk address (BIP84 m/84'/0'/0'/0/i), golden confirmed against a
// live freicoind (deriveaddresses on wpk(xprv/84h/0h/0h/0/*)); wpk program is the
// MAST short-hash, not hash160(pubkey).
const WPK_MAIN = {  // seed 000102..0f, m/84'/0'/0'/0/{0,1,3}
  0: 'fc1qwhjhfza8w7jhvx38xutsnqrnlmw2dsgag9lz20',
  1: 'fc1qnwl9qzr602f4jeedqy07sdnw8pk8pdnc8felw6',
  3: 'fc1qgmvd5juadlzp0muxyrs290salxqjfl40p2s5r9',
};
for (const [i, want] of Object.entries(WPK_MAIN)) {
  const got = encodeWitness('main', 0, wpkProgramHex(derivePath(SEED, `m/84'/0'/0'/0/${i}`)));
  check(got === want, `wpk m/84'/0'/0'/0/${i}`, { got, want });
}

console.log(`hd (BIP32 vector 1 + Freicoin wpk addrs) parity: ${ok}/${ok + fail} checks pass`);
if (firstfail) { console.log('FIRST FAIL:', JSON.stringify(firstfail)); process.exit(1); }
