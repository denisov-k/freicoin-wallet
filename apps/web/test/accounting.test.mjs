// Private accounting servers (whitepaper §2.4/§5.6) — the model: off-chain volume with a
// signed, hash-chained audit log; demurrage runs off-chain by the same arithmetic; solvency
// verifiable by anyone against the on-chain escrow; fraud is detected, not prevented — and
// detected is enough, because the audit is cheap and continuous.
import { check, finish } from './helpers.mjs';
import { FRC, assetIdOf, assetPresentValue } from '../../../core/assets.mjs';
import { AccountingServer, audit, netSettlement } from '../../../core/accounting.mjs';
import { pubkeyCompressed } from '../../../core/ecdsa.mjs';

const coop = { k: 18, interest: false, granularity: 1 };
const idCoop = assetIdOf(coop);
const rates = { [FRC]: { k: 20, interest: false }, [idCoop]: { k: 18, interest: false } };
const OP_SEC = 'ab'.repeat(32);
const srv = new AccountingServer({ operatorSec: OP_SEC, rates });

// on-chain escrow the auditor can see (what depositors paid in)
const escrow = [
  { assetId: FRC, value: 100000000n, refheight: 1000 },
  { assetId: idCoop, value: 5000n, refheight: 1000 },
];

// deposits credited at the depositing txs' lock heights
srv.deposit('alice', { assetId: FRC, value: 100000000n, refheight: 1000, txid: 'd1' });
srv.deposit('bob', { assetId: idCoop, value: 5000n, refheight: 1000, txid: 'd2' });

// instant off-chain transfers, MUCH later — demurrage has been running off-chain
const H = 1000 + 52560;   // ~a year of blocks
srv.transfer('alice', 'bob', FRC, 30000000n, H);
srv.transfer('bob', 'alice', idCoop, 1000n, H);
srv.checkpoint(H);

check('log is non-trivial and signed', srv.log.length === 5 && srv.log.every(e => e.sig));

// the audit passes: chain, signatures, checkpoint, solvency
const ok = audit({ log: srv.log, operatorPub: srv.pub, ledger: srv.ledger, escrowCoins: escrow, rates, atHeight: H });
check('audit passes on the honest server', ok.ok === true, ok.err);

// off-chain demurrage == on-chain demurrage: alice's FRC melted exactly like the escrow coin
const aliceFrc = srv.ledger.get('alice').filter(c => c.assetId === FRC)
  .reduce((a, c) => a + assetPresentValue(c.value, H - c.refheight, rates[FRC]), 0n);
const escrowFrcPv = assetPresentValue(100000000n, H - 1000, rates[FRC]);
check('off-chain balances melt by the exact on-chain kernel', aliceFrc === escrowFrcPv - 30000000n);

// FRAUD 1: the operator cooks a balance after the checkpoint — the audit catches it
const cooked = new Map([...srv.ledger].map(([u, cs]) => [u, cs.map(c => ({ ...c }))]));
cooked.get('bob').push({ assetId: FRC, value: 99999999n, refheight: H });
const bad1 = audit({ log: srv.log, operatorPub: srv.pub, ledger: cooked, escrowCoins: escrow, rates, atHeight: H });
check('audit catches a cooked ledger (checkpoint mismatch)', !bad1.ok && /checkpoint/.test(bad1.err));

// FRAUD 2: a forged log entry (no operator signature over the altered hash)
const forged = srv.log.map(e => ({ ...e }));
forged[1] = { ...forged[1], data: { ...forged[1].data, value: 999999999n } };
const bad2 = audit({ log: forged, operatorPub: srv.pub, ledger: srv.ledger, escrowCoins: escrow, rates, atHeight: H });
check('audit catches log tampering', !bad2.ok);

// FRAUD 3: the operator siphons escrow (withdraws on-chain without debiting anyone)
const drained = [{ assetId: FRC, value: 40000000n, refheight: 1000 }, escrow[1]];
const bad3 = audit({ log: srv.log, operatorPub: srv.pub, ledger: srv.ledger, escrowCoins: drained, rates, atHeight: H });
check('audit catches insolvency (escrow < liabilities)', !bad3.ok && /INSOLVENT/.test(bad3.err));

// withdraw: user exits to the chain; liabilities shrink accordingly
srv.withdraw('bob', idCoop, 500n, H, 'wd1');
const owed = srv.liabilities(H);
const coopEscrowPv = assetPresentValue(5000n, H - 1000, rates[idCoop]);
check('withdraw shrinks liabilities below the (soon-shrinking) escrow', (owed.get(idCoop) ?? 0n) === coopEscrowPv - 500n);

// cross-server settlement: 4 off-chain IOUs net to ONE on-chain amount per asset
const net = netSettlement([
  { assetId: FRC, amount: 5000000n, dir: 'AtoB' },
  { assetId: FRC, amount: 2000000n, dir: 'BtoA' },
  { assetId: FRC, amount: 1000000n, dir: 'BtoA' },
  { assetId: idCoop, amount: 100n, dir: 'AtoB' },
]);
check('cross-server: IOUs net to one transfer per asset', net.get(FRC) === 2000000n && net.get(idCoop) === 100n);

finish();
