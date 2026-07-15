# testnet aux mining — NOT A BUG (withdrawn); design note instead

## Resolution (2026-07-14, after code comparison with tradecraft/28.1)

The aux-pow mining path in rebase-31 is byte-for-byte equivalent to the official 28.1 branch,
and the "can't find a block" observation was a misreading of difficulty semantics on our side:

- `getauxdifficulty` returns `ConvertBitsToDifficulty(m_commit_bits)` — i.e. difficulty relative
  to the NATIVE diff-1 target (0x1d00ffff), not to `aux_pow_limit`.
- Testnet's aux difficulty of ~1,049,875 therefore means ≈ 2^32 × 1.05e6 ≈ **4.5×10¹⁵ hashes
  per block**. A CPU cannot mine this; 100M tries returning nothing is the expected outcome.

## Remaining design observation (possible upstream discussion, not a bug report)

The testnet is in a difficulty deadlock: its aux difficulty was set by merge miners who have
since left (last block 2025-03), and the filtered retarget can lower difficulty by at most
÷1.0625 **per mined block** — so a dead network can never decay back to CPU-mineable levels.
Bitcoin's testnets handle this with a 20-minute min-difficulty rule; Freicoin's testnet has
no equivalent for the aux target.

Options worth raising with upstream (or deciding for our own rebase):
1. Add a testnet-only min-difficulty escape hatch for the aux target (mirroring Bitcoin's rule).
2. Reset testnet (new genesis) as part of the rebase-31 release.
3. Leave as-is and treat signet/custom chains as the supported test story.
