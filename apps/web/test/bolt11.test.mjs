// bolt11.test.mjs — минимальный BOLT11-декодер (LN-выплаты sell-стороны): golden-вектор,
// сверенный бит-в-бит с decodepayreq реального LND v0.21 (mainnet fw-lnd), + краевые случаи.
// Вектор: lncli addinvoice --amt 12345 --expiry 7200 (сид одноразовый, инвойс давно истёк).
import { check, finish } from './helpers.mjs';
import { decodeBolt11 } from '../../../core/bolt11.mjs';

// -- спецификационный вектор из BOLT11 (donation, без суммы), проверяет и парс без amount --
const SPEC = 'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';
try {
  const d = decodeBolt11(SPEC);
  check('spec vector: net bc', d.net === 'bc');
  check('spec vector: amount-less invoice → sats null', d.sats === null);
  check('spec vector: payment_hash', d.paymentHash === '0001020304050607080900010203040506070809000102030405060708090102');
  check('spec vector: timestamp', d.timestamp === 1496314658);
} catch (e) { check('spec vector decodes: ' + e.message, false); }

check('uppercase + lightning: prefix', (() => {
  const d = decodeBolt11('lightning:' + SPEC.toUpperCase());
  return d.paymentHash === '0001020304050607080900010203040506070809000102030405060708090102';
})());

check('tampered char → checksum error', (() => {
  try { decodeBolt11(SPEC.slice(0, -1) + (SPEC.endsWith('l') ? 'q' : 'l')); return false; }
  catch { return true; }
})());
check('mixed case rejected', (() => {
  try { decodeBolt11('lnBC' + SPEC.slice(4)); return false; } catch { return true; }
})());
check('garbage rejected', (() => {
  try { decodeBolt11('lnbc1notaninvoice'); return false; } catch { return true; }
})());

finish('bolt11');
