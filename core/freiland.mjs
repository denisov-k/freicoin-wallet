// freiland.mjs — Freiland (Гезеллев второй столп) поверх демерреджа Freicoin.
// НИКАКОЙ новой экономики: «ценность слота» V ≡ present value залога, а «земельная рента» ≡
// демерредж этого залога. Всё считается консенсус-точным кернелом timeAdjustValue — этот модуль
// лишь называет его в терминах Харбергера (ценность / рента / долив / статус).
//
// Инвариант реестра: V слота = present value его залога прямо сейчас. Отсюда всё:
//   • V — цена принудительного выкупа (любой платит V — забирает слот-токен);
//   • V — база ренты; залог тает демерреджем ≈ 4,889 %/год, и этот тающий кусок И ЕСТЬ рента;
//   • забросил долив — залог тает → V падает → слот дёшево выкупают (авто-вычистка сквоттеров).
// Держатель при регистрации/доливе запирает nominal == желаемую V в текущей высоте (distance 0,
// свежие монеты стоят номинал), а landValue показывает, во что это превратилось позже.
import { timeAdjustValue } from './demurrage.mjs';
import { sha256d, ripemd160 } from './crypto.mjs';

// FRC wpk-spk по компресс.-публичному ключу (то же, что wpkProgramHex кошелька): 0014 ‖
// ripemd160(HASH256(0x00 ‖ 0x21 pk 0xac)). Общий для релея (проверка залога) и кошелька (адрес залога).
export function frcWpkSpk(pubHex) {
  const pk = Buffer.from(pubHex, 'hex');
  const p2pk = Buffer.concat([Buffer.from([0x21]), pk, Buffer.from([0xac])]);
  return '0014' + ripemd160(sha256d(Buffer.concat([Buffer.from([0x00]), p2pk]))).toString('hex');
}

// Консенсус-канон: демерредж-«год» = 52 560 блоков (600 с × 52 560 = ровно 365 дней). Совпадает
// с вектором ядра {v:1e8, d:52560, e:95111038}. НЕ 365.25 — берём ту же длину, что и консенсус.
export const BLOCKS_PER_YEAR = 52560;

// Годовая ставка ренты, ВЫВЕДЕННАЯ из ядра (не вшитая): 1 - timeAdjustValue(U, год)/U.
// Для U = 1e8 это ровно (1e8 - 95111038)/1e8 = 0.04888962 ≈ 4,889 %.
const RATE_UNIT = 1_000_000_000_000n;   // 1e12, крупная база — усечение ставки пренебрежимо
export const ANNUAL_RATE_PPM = Number(RATE_UNIT - timeAdjustValue(RATE_UNIT, BLOCKS_PER_YEAR)) / Number(RATE_UNIT) * 1e6; // ≈ 48889.6 ppm

/** Текущая ценность слота = present value залога (цена выкупа сейчас), кария.
 *  @param {bigint} depositNominal — номинал залога при запирании
 *  @param {number} refheight — высота запирания залога
 *  @param {number} height — текущая высота */
export function landValue(depositNominal, refheight, height) {
  const d = height - refheight;
  if (d < 0) throw new Error('height < refheight');
  return timeAdjustValue(depositNominal, d);
}

/** Сколько номинала запереть СЕЙЧАС (distance 0), чтобы ценность слота = targetV.
 *  Свежие монеты стоят номинал, поэтому это ровно targetV — но именуем явно. */
export function requiredDeposit(targetV) {
  const v = BigInt(targetV);
  if (v <= 0n) throw new Error('V must be > 0');
  return v;
}

/** Рента, «стёкшая» между высотами h0 и h1 (h1 > h0): падение present value залога. */
export function rentBetween(depositNominal, refheight, h0, h1) {
  return landValue(depositNominal, refheight, h0) - landValue(depositNominal, refheight, h1);
}

/** Оценка годовой ренты слота ценности V (кария/год) = V − PV(V, год). */
export function annualRent(V) {
  const v = BigInt(V);
  return v - timeAdjustValue(v, BLOCKS_PER_YEAR);
}

/** Долив: сколько СВЕЖЕГО номинала добавить, чтобы ценность вернулась к targetV.
 *  currentV — текущая ценность (landValue). Свежие монеты (distance 0) добавляют PV == номинал. */
export function topUpNominal(currentV, targetV) {
  const need = BigInt(targetV) - BigInt(currentV);
  return need > 0n ? need : 0n;
}

/** Статус слота: текущая ценность и «истёк» (ценность просела ниже минимума регистрации minV —
 *  слот фактически заброшен и выкупается за бесценок / освобождается). */
export function landStatus(depositNominal, refheight, height, minV) {
  const value = landValue(depositNominal, refheight, height);
  return { value, lapsed: value < BigInt(minV) };
}

// Допустимое имя слота (первый неймспейс — человекочитаемые имена): 1..32, строчные латиница/цифры
// и разделители _ - , но не в начале/конце и не подряд. Токен-строка nv3 == это имя.
const LAND_NAME_RE = /^(?!.*[_-]{2})[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$/;
export const validLandName = name => typeof name === 'string' && LAND_NAME_RE.test(name);
