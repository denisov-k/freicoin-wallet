// i18n.mjs — tiny translation layer. Keys ARE the English strings (unknown keys pass
// through untouched, so new UI text degrades to English instead of breaking). Language
// defaults to the browser's, overridable in Settings (fw_lang).
const RU = {
  'Balance': 'Баланс', 'Receive': 'Получить', 'Send': 'Отправить', 'Activity': 'Активность',
  'Network': 'Сеть', 'Status': 'Статус', 'Downloaded': 'Загружено',
  'synced ✓ (verified)': 'синхронизирован ✓', 'syncing…': 'синхронизация…', 'offline': 'нет связи',
  'connecting…': 'подключение…', 'bridge unreachable — retrying': 'мост недоступен — повторяем…',
  'headers': 'заголовки', 'scan': 'скан', 'blocks': 'блоки', 'PoW': 'PoW',
  'first sync…': 'первая синхронизация…', 'pending': 'ожидает', 'conf': 'подтв.',
  'no transactions yet': 'пока нет транзакций', 'just now': 'только что', 'm ago': ' мин назад', 'h ago': ' ч назад',
  'sync failed — ': 'сбой синхронизации — ', '↻ Retry': '↻ Повторить',
  'Receive address': 'Адрес получения', 'Copy': 'Копировать', 'Next →': 'Следующий →', 'copied ✓': 'скопировано ✓',
  'available…': 'доступно…', 'available ': 'доступно ',
  'To address': 'Адрес получателя', 'Amount (FRC)': 'Сумма (FRC)', 'Max': 'Макс', 'Review': 'Проверить',
  'To': 'Кому', 'Amount': 'Сумма', 'Fee': 'Комиссия', 'Inputs': 'Входы',
  'Confirm & broadcast': 'Подтвердить и отправить', 'Cancel': 'Отмена', 'Sent ✓': 'Отправлено ✓',
  'broadcasting…': 'отправка…', 'broadcast ✓': 'отправлено ✓', 'broadcast failed: ': 'сбой отправки: ',
  'review the transaction': 'проверьте транзакцию', 'building…': 'подготовка…',
  'invalid Freicoin address': 'неверный адрес Freicoin', 'enter an amount': 'введите сумму',
  'amount exceeds available': 'сумма превышает доступную', 'Copy txid': 'Копировать txid',
  'Language': 'Язык', 'Theme': 'Тема', 'System': 'Системная', 'Dark': 'Тёмная', 'Light': 'Светлая',
  'Bridge URL (neutrino P2P relay)': 'Мост (neutrino P2P)', 'Wallet secret': 'Секрет кошелька',
  'recovery phrase': 'фраза восстановления', 'hex seed': 'hex-сид',
  '🔓 Lock': '🔓 Заблокировать', 'Change passphrase': 'Сменить пароль', '🔒 Secure with passphrase': '🔒 Защитить паролем',
  '🔒 Secret is encrypted with your passphrase (AES-GCM). It is only decrypted in memory.':
    '🔒 Секрет зашифрован вашим паролем (AES-GCM) и расшифровывается только в памяти.',
  '⚠ Secret is stored unencrypted — set a passphrase to secure it.':
    '⚠ Секрет хранится без шифрования — задайте пароль.',
  'Set a passphrase': 'Задать пароль', 'passphrase': 'пароль', 'repeat passphrase': 'повторите пароль',
  'Encrypt': 'Зашифровать', 'passphrase too short': 'пароль слишком короткий',
  'passphrases do not match': 'пароли не совпадают', 'passphrase changed': 'пароль изменён',
  'wallet secured 🔒': 'кошелёк защищён 🔒', 'saved': 'сохранено',
  'Unlock wallet': 'Разблокировать кошелёк', 'Unlock': 'Разблокировать',
  'unlocking…': 'разблокировка…', 'wrong passphrase': 'неверный пароль',
  'A trustless light wallet — keys never leave your device.': 'Лёгкий кошелёк без доверия — ключи не покидают ваше устройство.',
  'Create a new wallet': 'Создать новый кошелёк', 'Restore from recovery phrase': 'Восстановить из фразы',
  '⚠ Write these 12 words down. They are the ONLY key to your money — no one can recover them for you.':
    '⚠ Запишите эти 12 слов. Это ЕДИНСТВЕННЫЙ ключ к вашим деньгам — восстановить его за вас не сможет никто.',
  'I wrote them down': 'Я записал(а) слова', 'Recovery phrase or hex seed': 'Фраза восстановления или hex-сид',
  'Restoring an existing wallet scans its whole history once — this can take a minute.':
    'Восстановление сканирует всю историю кошелька один раз — это может занять минуту.',
  'Restore': 'Восстановить',
  'wallet created — you can add a passphrase in Settings 🔒': 'кошелёк создан — пароль можно задать в настройках 🔒',
  'wallet restored — scanning its history…': 'кошелёк восстановлен — сканируем историю…',
  'Protect your wallet with a passphrase — it encrypts the phrase on this device.':
    'Защитите кошелёк паролем — фраза будет храниться на устройстве в зашифрованном виде.',
  'Skip for now': 'Пропустить пока',
  'you can add a passphrase later in Settings': 'пароль можно задать позже в настройках',
  'Auto-locks after 5 minutes of inactivity.': 'Автоблокировка через 5 минут бездействия.',
  'verifying…': 'проверка…',
  '← Prev': '← Предыдущий',
  'send': 'отправка', 'receive': 'получение', 'generate': 'добыча', 'immature': 'незрелые',
  'Show': 'Показать', 'Hide': 'Скрыть',
  'Log out of wallet': 'Выйти из кошелька',
  'This removes the wallet from this device. Without the recovery phrase the funds are UNRECOVERABLE.':
    'Кошелёк будет удалён с этого устройства. Без фразы восстановления средства ВОССТАНОВИТЬ НЕВОЗМОЖНО.',
  'Log out & wipe': 'Выйти и удалить',
};

const TABLES = { ru: RU };
let lang;
try { lang = localStorage.getItem('fw_lang') || (navigator.language?.toLowerCase().startsWith('ru') ? 'ru' : 'en'); }
catch { lang = 'en'; }

export const tr = s => TABLES[lang]?.[s] ?? s;
export const getLang = () => lang;
export const setLang = l => { lang = TABLES[l] || l === 'en' ? l : 'en'; try { localStorage.setItem('fw_lang', lang); } catch {} };
export const LANGS = { en: 'English', ru: 'Русский' };
