# script_tests/script_build: "Missing auto script_valid test: P2PK with non-push scriptSig but with P2SH validation"

> **STATUS (2026-07-14): OUR rebase bug** (fc-nv3 / rebase tree), found while running the full
> test suite. NOT caused by the nv3 extension-output work — reproduced on a CLEAN checkout with
> those changes stashed. Likely inherited from an earlier rebase step; needs triage in our tree.

## Symptom

`test_bitcoin --run_test=script_tests` fails one assertion:

```
./test/script_tests.cpp(912): error: in "script_tests/script_build":
  Missing auto script_valid test: P2PK with non-push scriptSig but with P2SH validation
```

## Notes

- This is the script_build self-consistency check (the generated JSON test vectors vs the
  hand-listed cases), unrelated to witness programs, assets, or sighash — pure P2PK/P2SH.
- Reproduced with `git stash` of the nv3 extension-output changes, so it predates that work.
- Every other suite touched by our consensus work is green: **asset_tests → No errors detected**;
  sighash/transaction/coins pass.

## To triage

Diff script_tests.cpp's script_build case list against upstream tradecraft ≤28.1 / the Core 31
base to find which rebase step dropped or renamed the "P2PK with non-push scriptSig but with P2SH
validation" expected-valid entry (or its generator counterpart).
