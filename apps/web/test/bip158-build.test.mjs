// bip158-build.test.mjs — строитель BIP158 basic-фильтров (фид фазы 2 Lightning).
// Golden-вектор снят с реального bitcoind v29 regtest (getblockfilter, blockfilterindex=1);
// в живом прогоне строитель сверялся с узлом на 61 блоке подряд — 61/61 бит-в-бит.
// Плюс инвариант: построенный фильтр обязан матчить свои же скрипты и не матчить чужие.
import { check, finish } from './helpers.mjs';
import { buildFilter, filterMatchesAny } from '../src/services/light/net/bip158.mjs';

const V = {
  hash: '30fce708cb767bcffe791c31dd9625ff6de3b2790f3de323a4769a65abca8a27',
  scripts: [
    '0014bb95d117c287f42fe3c7f55bb5713c8fb112697e',
    '51205c154de049b19528af6c88a635f6e120488a542a20c8b8e84d8feecc88147472',
    '00149c70ac2f3c0575d2115ab02bcc9b1dd4e21d4f5c',
  ],
  ref: '03be37732a9fc2417c',
};

const built = buildFilter(V.hash, V.scripts);
check('golden: byte-exact vs bitcoind getblockfilter', built.toString('hex') === V.ref);

for (const s of V.scripts)
  check(`roundtrip: own script matches (${s.slice(0, 12)}…)`, filterMatchesAny(built, V.hash, [s]));
check('roundtrip: foreign script does not match', !filterMatchesAny(built, V.hash, ['0014' + 'ab'.repeat(20)]));

// дубликаты скриптов схлопываются (N по уникальным элементам)
check('duplicates collapse', buildFilter(V.hash, [...V.scripts, V.scripts[0], V.scripts[0]]).toString('hex') === V.ref);
// пустые и OP_RETURN не участвуют (фильтруются вызывающим, но и пустая строка не ломает)
check('empty scripts ignored', buildFilter(V.hash, ['', ...V.scripts]).toString('hex') === V.ref);
// пустой набор → varint(0)
check('empty set → 00', buildFilter(V.hash, []).toString('hex') === '00');

finish('bip158-build');
