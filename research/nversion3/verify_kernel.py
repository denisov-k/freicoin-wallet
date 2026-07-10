#!/usr/bin/env python3
"""Resolve the one open nVersion=3-lite spec decision: how to generalise Freicoin's demurrage
kernel to an arbitrary per-asset rate 2^-k while staying BIT-IDENTICAL to the host currency
at k=20.

Freicoin's kernel (consensus/amount.cpp TimeAdjustValueForward) is an exponentiation ladder of
(1 - 2^-20)^(2^bit) in 0.64 fixed point. Regenerating that ladder for arbitrary k by squaring
the base (1 - 2^-k): naive 64-bit squaring DRIFTS (a few ULPs) and fails to match the shipped
table. Result below: >= 96 fractional GUARD BITS during the squaring reproduces the table
exactly, and the full adjustment then matches the canonical kernel over every test vector.
This is the canonical algorithm the C++ port implements (one-time per-asset ladder generation,
cached like the static FRC table).
"""
K32 = [0xfffff000,0x00000000, 0xffffe000,0x01000000, 0xffffc000,0x05ffffc0, 0xffff8000,0x1bfffc80,
 0xffff0000,0x77ffdd00, 0xfffe0001,0xeffeca00, 0xfffc0007,0xdff5d409, 0xfff8001f,0xbfaca8a2,
 0xfff0007f,0x7d5d5a6a, 0xffe001fe,0xeacb48a8, 0xffc007fd,0x55dfda2a, 0xff801ff6,0xad5499cd,
 0xff007fcd,0x67f98aad, 0xfe01fe9b,0x74f0943e, 0xfc07f540,0x767d2a82, 0xf81fab16,0x3dc15990,
 0xf07d5f65,0xf9604ac9, 0xe1eb5045,0x80b6ebf7, 0xc75f7b66,0xa5075def, 0x9b459576,0x663bbb3e,
 0x5e2d55e7,0x48e27ab4, 0x22a5531d,0x29a95916, 0x04b054d7,0xfda49c4d, 0x0015fc1b,0x85085be9,
 0x000001e3,0x54ca043c, 0x00000000,0x00039089]
M64 = (1<<64)-1
Ltab = [(K32[2*b]<<32)|K32[2*b+1] for b in range(26)]

def ladder(k, P):
    base=(1<<P)-(1<<(P-k)); c=base; L=[]
    for _ in range(26): L.append((c>>(P-64))&M64); c=(c*c)>>P
    return L

def adj(value, distance, L):                  # structural port of TimeAdjustValueForward
    if distance==0: return value
    if distance>=(1<<26): return 0
    sign=(value>0)-(value<0); v=abs(value); w=None
    for bit in range(26):
        if distance>>bit & 1:
            e=L[bit]
            if w is None: w=e; continue
            w=(w*e)>>64
    return 0 if w is None else sign*((v*w)>>64)

if __name__=='__main__':
    print("guard-bit precision sweep (k=20 ladder vs shipped table):")
    for P in (64,80,96,128):
        m=sum(1 for i,x in enumerate(ladder(20,P)) if x!=Ltab[i])
        print(f"  P={P:3}: {m}/26 entries mismatched{'   <-- canonical' if m==0 and P==96 else ''}")
    L20=ladder(20,96)
    vecs=[(v,d) for v in (1,10**8,9007199254740991,5*10**8,1234567890,42)
                for d in (1,2,3,7,96,1000,52560,485000,(1<<26)-1)]
    bad=sum(1 for v,d in vecs if adj(v,d,L20)!=adj(v,d,Ltab))
    print(f"full adjustment adj(k=20,P=96) == canonical over {len(vecs)} vectors: {'YES' if not bad else f'NO ({bad})'}")
    # sample: a community currency at k=18 melts faster; report the 10-FRC/5000-block figure
    N=10**9
    print(f"sample k=18 (faster) melt over 5000 blocks: {(N-adj(N,5000,ladder(18,96)))/1e8:.6f} FRC "
          f"vs FRC k=20 {(N-adj(N,5000,L20))/1e8:.6f} FRC")
