// freiland.test.mjs — Freiland-реестр, шаг 1: залог↔ценность↔рента. Всё сверяется с
// консенсус-кернелом демерреджа (timeAdjustValue) и его каноническим годовым вектором.
import { check, finish } from './helpers.mjs';
import { timeAdjustValue } from '../../../core/demurrage.mjs';
import {
  BLOCKS_PER_YEAR, ANNUAL_RATE_PPM,
  landValue, requiredDeposit, rentBetween, annualRent, topUpNominal, landStatus,
} from '../../../core/freiland.mjs';

const U = 100_000_000n;   // 1 FRC в кария

// --- год = 52560 блоков, канонический вектор ядра {v:1e8, d:52560, e:95111038} ---
check('BLOCKS_PER_YEAR = 52560 (600с × 52560 = 365 суток)', BLOCKS_PER_YEAR === 52560);
check('годовой вектор ядра: 1 FRC → 95111038', timeAdjustValue(U, BLOCKS_PER_YEAR) === 95111038n);

// --- ценность слота ≡ present value залога (совпадает с кернелом) ---
check('landValue == timeAdjustValue (distance 0)', landValue(U, 100, 100) === U);
check('landValue == timeAdjustValue (144 блока)', landValue(U, 100, 244) === timeAdjustValue(U, 144));
check('landValue за год = 95111038', landValue(U, 1000, 1000 + BLOCKS_PER_YEAR) === 95111038n);

// --- рента = стёкший present value; годовая рента 1 FRC ровно 4 888 962 кария (4,889%) ---
check('annualRent(1 FRC) = 4888962 кария', annualRent(U) === 4_888_962n);
check('годовая ставка ≈ 4,889% (ppm ~48889)', Math.round(ANNUAL_RATE_PPM) === 48890 || Math.abs(ANNUAL_RATE_PPM - 48889.6) < 2);
check('annualRent == V − PV(V, год)', annualRent(5_000n * U) === 5_000n * U - timeAdjustValue(5_000n * U, BLOCKS_PER_YEAR));

// --- rentBetween аддитивен и согласован с landValue ---
{
  const dep = 5_000n * U, rh = 0;
  const r1 = rentBetween(dep, rh, 0, 20000);
  const r2 = rentBetween(dep, rh, 20000, BLOCKS_PER_YEAR);
  check('rentBetween аддитивен по окну', r1 + r2 === annualRent(dep));   // dep свежий (rh=0, PV=nominal)
  check('rentBetween = падение ценности', r1 === landValue(dep, rh, 0) - landValue(dep, rh, 20000));
}

// --- requiredDeposit: заперев V сейчас, ценность в момент запирания == V ---
check('requiredDeposit(V) = V', requiredDeposit(5_000n * U) === 5_000n * U);
check('свежий залог стоит номинал', landValue(requiredDeposit(3_333n * U), 500, 500) === 3_333n * U);
check('requiredDeposit(0) бросает', (() => { try { requiredDeposit(0n); return false; } catch { return true; } })());

// --- долив: добавить свежий номинал, чтобы вернуть ценность к цели ---
{
  const dep = 1_000n * U, rh = 0, h = BLOCKS_PER_YEAR;   // за год стекло до ~951 FRC
  const cur = landValue(dep, rh, h);
  const add = topUpNominal(cur, 1_000n * U);
  check('топ-ап покрывает стёкшее', cur + add === 1_000n * U);   // свежие монеты PV==номинал
  check('топ-ап 0, если ценность ≥ цели', topUpNominal(1_200n * U, 1_000n * U) === 0n);
}

// --- статус: истёк, когда ценность просела ниже минимума регистрации ---
{
  const minV = 100n * U;
  check('здорова: ценность ≥ minV', landStatus(5_000n * U, 0, 100, minV).lapsed === false);
  // огромный distance → PV → 0 → истёк
  check('истекла: ценность < minV', landStatus(minV, 0, BLOCKS_PER_YEAR * 40, minV).lapsed === true);
}

finish('freiland');
