// Reference C++ for the generalized demurrage kernel TimeAdjustValueForwardK(value, distance, k).
// Ladder generation uses an EXACT 96-guard-bit square via __int128 splitting (naive 64-bit
// squaring drifts); the ladder entries (truncated to 64 bits) then feed the EXISTING kernel
// multiply verbatim. Verified: k=20 reproduces the canonical table + full result bit-for-bit,
// and all model golden vectors (k=18,20,22) match.
#include <cstdint>
#include <array>
#include <cstdio>
#include <cstdlib>
using u32=uint32_t; using u64=uint64_t; using u128=unsigned __int128;

static std::array<u32,52> K32 = {
 0xfffff000,0x00000000, 0xffffe000,0x01000000, 0xffffc000,0x05ffffc0, 0xffff8000,0x1bfffc80,
 0xffff0000,0x77ffdd00, 0xfffe0001,0xeffeca00, 0xfffc0007,0xdff5d409, 0xfff8001f,0xbfaca8a2,
 0xfff0007f,0x7d5d5a6a, 0xffe001fe,0xeacb48a8, 0xffc007fd,0x55dfda2a, 0xff801ff6,0xad5499cd,
 0xff007fcd,0x67f98aad, 0xfe01fe9b,0x74f0943e, 0xfc07f540,0x767d2a82, 0xf81fab16,0x3dc15990,
 0xf07d5f65,0xf9604ac9, 0xe1eb5045,0x80b6ebf7, 0xc75f7b66,0xa5075def, 0x9b459576,0x663bbb3e,
 0x5e2d55e7,0x48e27ab4, 0x22a5531d,0x29a95916, 0x04b054d7,0xfda49c4d, 0x0015fc1b,0x85085be9,
 0x000001e3,0x54ca043c, 0x00000000,0x00039089 };

// exact (a*a) >> 96 for a < 2^96, via 64-bit split: a = aH*2^64 + aL, aH<2^32, aL<2^64
static u128 sqr_shift96(u128 a){
  u64 aH=(u64)(a>>64), aL=(u64)a;
  u128 X = (u128)2*aH*aL;                       // < 2^97
  u128 Y = (u128)aL*aL;                         // < 2^128
  u128 lo = (((X & 0xffffffffULL) << 64) + Y) >> 96;
  return ((u128)aH*aH << 32) + (X >> 32) + lo;
}
// build the 64-bit-fraction ladder for shift k at 96 guard bits (demurrage: base = 1 - 2^-k)
static void ladderK(int k, std::array<u32,26*2>& L){
  const int P=96; u128 c = ((u128)1<<P) - ((u128)1<<(P-k));
  for(int bit=0;bit<26;++bit){ u64 e=(u64)(c>>(P-64)); L[2*bit]=(u32)(e>>32); L[2*bit+1]=(u32)e; c=sqr_shift96(c); }
}
// the kernel's 0.64 truncating multiply (unchanged)
static void mul(u32& a0,u32& a1,u32 b0,u32 b1){
  u64 sum,overflow; auto shift32=[&]{sum=(overflow<<32)+(sum>>32);overflow=0;}; auto term=[&](u64 v){overflow+=(sum+v)<sum;sum+=v;};
  u64 w0=a0,w1=a1,k0=b0,k1=b1; overflow=0; sum=k1*w0; term(k0*w1); shift32(); term(k0*w0); a1=(u32)sum; shift32(); a0=(u32)sum;
}
static int64_t adjK(int64_t value, u32 distance, const std::array<u32,52>& L){
  if(distance==0) return value; if(distance>=((u32)1<<26)) return 0;
  int sign=(value>0)-(value<0); u64 v=(u64)std::llabs(value);
  u32 w0=0,w1=0; bool first=true;
  for(int bit=0; distance; distance>>=1,++bit) if(distance&1){ if(first){first=false;w0=L[2*bit];w1=L[2*bit+1];continue;} mul(w0,w1,L[2*bit],L[2*bit+1]); }
  u64 sum,overflow; auto shift32=[&]{sum=(overflow<<32)+(sum>>32);overflow=0;}; auto term=[&](u64 x){overflow+=(sum+x)<sum;sum+=x;};
  u64 V0=v>>32,V1=(u32)v; overflow=0; sum=((u64)w1*V1)>>32; term((u64)w1*V0); term((u64)w0*V1); shift32(); term((u64)w0*V0);
  return sign*(int64_t)sum;
}
static int64_t TimeAdjustValueForwardK(int64_t value, u32 distance, int k){
  std::array<u32,52> L; ladderK(k,L); return adjK(value,distance,L);
}

int main(){
  // 1. k=20 ladder reproduces the canonical shipped table
  std::array<u32,52> L20; ladderK(20,L20);
  int mism=0; for(int i=0;i<52;++i) if(L20[i]!=K32[i]) mism++;
  printf("k=20 ladder == canonical table: %s (%d/52 mismatched)\n", mism?"NO":"YES", mism);
  // 2. golden vectors from the JS/py model
  FILE* f=fopen("/tmp/claude-0/-root-free-money/e555c6c3-1be8-497c-bfab-7ed5f9628ddf/scratchpad/golden.txt","r");
  int k; long long v,d,exp; int bad=0,tot=0;
  while(fscanf(f,"%d %lld %lld %lld",&k,&v,&d,&exp)==4){ tot++; long long got=TimeAdjustValueForwardK(v,(u32)d,k); if(got!=exp){ bad++; if(bad<=3) printf("  MISMATCH k=%d v=%lld d=%lld got=%lld exp=%lld\n",k,v,d,got,exp);} }
  fclose(f);
  printf("golden vectors (k=18,20,22) match model: %s (%d/%d bad)\n", bad?"NO":"YES", bad, tot);
  return (mism||bad)?1:0;
}
