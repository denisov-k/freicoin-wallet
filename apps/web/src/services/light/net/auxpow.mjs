// auxpow.mjs — Freicoin merged-mining (aux-pow) proof-of-work verification, a port
// of CBlockHeader::GetAuxiliaryHash + the two-stage target check in CheckProofOfWork.
// This is what makes the light client trustless on mainnet: it proves each header
// was mined (via a parent-chain block) to the required difficulty, rather than
// trusting the relay's chain. All hashes are handled in internal (little-endian)
// byte order, as uint256::begin() gives.
import { Buffer } from 'buffer';
import { SHA256 } from './sha256mid.mjs';
import { sha256d } from '@core/crypto.mjs';
import { readVarint, readBVarint } from './p2p.mjs';

const MIDSTATE_IV = Buffer.from('1e4e0f955a4bc81c08c8af1c94f34b9d0af2f450dc24a3bcef98318faf5e2506', 'hex');
// consensus.aux_pow_path (mainnet) = uint256{"6329...7ff6"} → internal bytes are the reverse.
const AUX_POW_PATH = { main: Buffer.from('632938ec752e63b7f63cdd9a16b336c6c5cefbaad66278e402ce59d706f57ff6', 'hex').reverse() };

// MerkleHash_Sha256Midstate(left, right): CSHA256(_MidstateIV) over left||right, raw state out.
const merkleMid = (l, r) => new SHA256().loadMidstate(MIDSTATE_IV, null, 0).write(l).write(r).midstate();
// MerkleHash_Hash256(left, right): double-SHA256 of left||right.
const merkleH256 = (l, r) => Buffer.from(sha256d(Buffer.concat([Buffer.from(l), Buffer.from(r)])));

const u32le = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const i32le = v => { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); return b; };
const u64le = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };

// 80-byte base header serialization (version, prev, merkle, time, bits, nonce).
const serHeader = h => Buffer.concat([i32le(h.version), Buffer.from(h.prev), Buffer.from(h.merkle), u32le(h.time), u32le(h.bits), u32le(h.nonce)]);
const headerHash = h => Buffer.from(sha256d(serHeader(h)));    // internal order

/** Parse an AuxProofOfWork struct starting at offset `o`. Returns {fields, end}. */
export function parseAuxPow(buf, o) {
  const rd32 = () => { const v = Buffer.from(buf.subarray(o, o + 32)); o += 32; return v; };
  const ru32 = () => { const v = buf.readUInt32LE(o) >>> 0; o += 4; return v; };
  const ri32 = () => { const v = buf.readInt32LE(o); o += 4; return v; };
  const ru64 = () => { const v = buf.readBigUInt64LE(o); o += 8; return v; };
  const a = {};
  a.commit_version = ri32();
  a.commit_merkle = rd32();
  a.commit_time = ru32();
  a.commit_bits = ru32();
  a.commit_nonce = ru32();
  a.secret_lo = ru64();
  a.secret_hi = ru64();
  let n; [n, o] = readVarint(buf, o);
  a.commit_branch = []; for (let i = 0; i < n; i++) { const skip = buf[o++]; a.commit_branch.push({ skip, hash: rd32() }); }
  a.midstate_hash = rd32();
  [n, o] = readVarint(buf, o); a.midstate_buffer = Buffer.from(buf.subarray(o, o + n)); o += n;
  [a.midstate_length, o] = readBVarint(buf, o);
  a.aux_lock_time = ru32();
  [n, o] = readVarint(buf, o); a.aux_branch = []; for (let i = 0; i < n; i++) a.aux_branch.push(rd32());
  let auxPos; [auxPos, o] = readBVarint(buf, o); a.aux_num_txns = auxPos + 1;
  a.aux_version = ri32();
  a.aux_prev = rd32();
  a.aux_bits = ru32();
  a.aux_nonce = ru32();
  return { aux: a, end: o };
}

// calc_remainder(key, used): for used=0 returns key; otherwise zeroes the top `used` bits.
function calcRemainder(key, used) {
  if (!used) return Buffer.from(key);
  const ret = Buffer.alloc(32);
  for (let idx = 0; idx < 256 - used; idx++) if (key[31 - (idx >> 3)] & (1 << (idx & 7))) ret[31 - (idx >> 3)] |= 1 << (idx & 7);
  return ret;
}
// calc_bits(key, begin, end): the [begin,end) key bits packed low + a terminator bit at (end-begin).
function calcBits(key, begin, end) {
  const ret = Buffer.alloc(32);
  for (let idx = begin; idx < end; idx++) {
    const src = 255 - idx, dst = end - idx - 1;
    if (key[31 - (src >> 3)] & (1 << (src & 7))) ret[31 - (dst >> 3)] |= 1 << (dst & 7);
  }
  const p = end - begin;
  ret[31 - (p >> 3)] |= 1 << (p & 7);
  return ret;
}
// Port of ComputeMerkleMapRootFromBranch (consensus/merkle.cpp): fold `value` up a
// Merkle-map path. Empty branch = the single-leaf case; a non-empty branch mixes in each
// sibling + the packed key bits skipped between levels.
function computeMerkleMapRoot(value, branch, key) {
  let total = 0; for (const s of branch) total += 1 + s.skip;
  if (total >= 256) return null;
  let hash = merkleMid(calcRemainder(key, total), value);
  for (const s of branch) {
    total -= 1;
    const begin = total - s.skip, end = total;
    hash = (key[31 - (end >> 3)] & (1 << (end & 7))) ? merkleMid(s.hash, hash) : merkleMid(hash, s.hash);
    hash = merkleMid(calcBits(key, begin, end), hash);
  }
  return hash;
}
function computeMerklePathAndMask(branchlen, position) {
  let max = 32; for (; max > 0; max--) if (position & ((1 << (max - 1)) >>> 0)) break;
  let mask = 0, path = position >>> 0;
  while (max > branchlen) {
    let i; for (i = max - 1; i >= 0; i--) if (!(path & ((1 << i) >>> 0))) break;
    if (i < 0) return [0, 0];
    mask = (mask | ((1 << i) >>> 0)) >>> 0;
    path = (((path & ~(((1 << (i + 1)) >>> 0) - 1)) >>> 1) | (path & (((1 << i) >>> 0) - 1))) >>> 0;
    max--;
  }
  return [path >>> 0, mask >>> 0];
}
function computeStableMerkleRoot(leaf, branch, path, mask) {
  let hash = Buffer.from(leaf), it = 0;
  while (it < branch.length) {
    if (mask & 1) hash = merkleH256(hash, hash);
    else { hash = (path & 1) ? merkleH256(branch[it], hash) : merkleH256(hash, branch[it]); it++; path >>>= 1; }
    mask >>>= 1;
  }
  while (mask & 1) { hash = merkleH256(hash, hash); mask >>>= 1; }
  return hash;
}

/** Port of CBlockHeader::GetAuxiliaryHash. `header` = {prev, time} (this block, internal
 *  prev bytes), `aux` = parsed AuxProofOfWork, `path` = aux_pow_path (internal). Returns
 *  { aux1, aux2 } (internal-order 32-byte Buffers). */
export function getAuxiliaryHash(header, aux, path) {
  // 1. block template hash
  let hash = headerHash({ version: aux.commit_version, prev: header.prev, merkle: aux.commit_merkle, time: aux.commit_time, bits: aux.commit_bits, nonce: aux.commit_nonce });
  // 2. commit to the secret
  const secretHash = Buffer.from(sha256d(Buffer.concat([u64le(aux.secret_lo), u64le(aux.secret_hi)])));
  hash = merkleMid(hash, secretHash);
  // 3. merkle-map root (commit_branch)
  hash = computeMerkleMapRoot(hash, aux.commit_branch, path);
  // 4. complete the aux block-final tx hash from the midstate
  {
    const m = new SHA256().loadMidstate(aux.midstate_hash, aux.midstate_buffer, aux.midstate_length);
    m.write(hash); m.write(Buffer.from([0x4b, 0x4a, 0x49, 0x48])); m.write(u32le(aux.aux_lock_time));
    hash = Buffer.from(m.finalize());
    hash = Buffer.from(new SHA256().write(hash).finalize());
  }
  // 5. aux block merkle root
  const [path2, mask] = computeMerklePathAndMask(aux.aux_branch.length, aux.aux_num_txns - 1);
  const auxMerkle = computeStableMerkleRoot(hash, aux.aux_branch, path2, mask);
  // 6. aux block header hash (1st stage)
  const aux1 = headerHash({ version: aux.aux_version, prev: aux.aux_prev, merkle: auxMerkle, time: header.time, bits: aux.aux_bits, nonce: aux.aux_nonce });
  // 7. 2nd-stage hash: raw SHA256 midstate over secret||commit_header(80)||aux1 (128 bytes)
  const blkhdr = serHeader({ version: aux.commit_version, prev: header.prev, merkle: aux.commit_merkle, time: aux.commit_time, bits: aux.commit_bits, nonce: aux.commit_nonce });
  const aux2 = Buffer.from(new SHA256().write(Buffer.concat([u64le(aux.secret_lo), u64le(aux.secret_hi), blkhdr, aux1])).midstate());
  return { aux1, aux2 };
}

const compactToTarget = bits => { const e = bits >>> 24, m = BigInt(bits & 0x007fffff); return e <= 3 ? m >> (8n * BigInt(3 - e)) : m << (8n * BigInt(e - 3)); };
const asNum = h => BigInt('0x' + Buffer.from(h).reverse().toString('hex'));   // internal LE bytes -> number

/** Verify the aux-pow: two-stage target check with bias. Returns true if the header's
 *  merged-mining proof meets its target. */
export function checkAuxPoW(header, aux, net = 'main') {
  const { aux1, aux2 } = getAuxiliaryHash(header, aux, AUX_POW_PATH[net]);
  const bias = aux.commit_nonce & 0xff;
  let target = compactToTarget(aux.commit_bits);
  if (target === 0n) return false;
  // bias check: (256 - target.bits()) < bias  -> reject
  if ((256 - target.toString(2).length) < bias) return false;
  target <<= BigInt(bias);
  if (asNum(aux1) > target) return false;                       // 1st stage
  const target2 = ((1n << 256n) - 1n) >> BigInt(bias);
  if (asNum(aux2) > target2) return false;                      // 2nd stage
  return true;
}
