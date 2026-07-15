// views/auth.mjs — the pre-wallet screens: welcome, sign-up (new phrase), log-in (restore),
// and the unlock/lock screen. All shared state stays in the app shell and is injected via initAuth
// (renderApp / recordNewWalletBirth / getVault / setSecret) — this module owns no wallet state.
import { tr, getLang, setLang, LANGS } from '@/services/i18n.mjs';
import { $, store, copy } from '@/components/dom.mjs';
import { toast } from '@/components/toast.mjs';
import { encryptSecret, decryptSecret } from '@/services/vault.mjs';
import { generateMnemonic, resolveSecret } from '@/services/wallet.mjs';

/** @type {{ renderApp: Function, recordNewWalletBirth: Function, getVault: Function, setSecret: (sec: string, pass?: string) => void }} */
let d;
export const initAuth = deps => { d = deps; };

// Onboarding passphrase step: encrypting the secret is the default path; skipping is an explicit
// (discouraged) choice — a mainnet wallet should not sit in plaintext storage.
function welcomePassStep(sec, doneToast) {
  $('#wBody').innerHTML = `
    <p class="sub">${tr('Protect your wallet with a passphrase — it encrypts the phrase on this device.')}</p>
    <input id="p1" type="password" placeholder="${tr('passphrase')}">
    <input id="p2" type="password" placeholder="${tr('repeat passphrase')}">
    <div class="row"><button id="wEnc">${tr('Encrypt')}</button><button id="wSkip" class="ghost">${tr('Skip for now')}</button></div>`;
  $('#wEnc').onclick = () => {
    const a = $('#p1').value, b = $('#p2').value;
    if (a.length < 4) return toast(tr('passphrase too short'), 'err');
    if (a !== b) return toast(tr('passphrases do not match'), 'err');
    store.set('fw_vault', JSON.stringify(encryptSecret(sec, a)));
    store.del('fw_seed'); d.setSecret(sec, a);
    d.renderApp(); toast(tr('wallet secured 🔒'));
  };
  $('#wSkip').onclick = () => {
    store.set('fw_seed', sec); d.setSecret(sec);
    d.renderApp(); toast(doneToast + ' · ' + tr('you can add a passphrase later in Settings'));
  };
}

export function renderWelcome() {
  $('#app').innerHTML = `<div class="lock"><div class="lockcard">
    <div class="lockicon fmark" aria-hidden="true">ƒ</div><h2>Freicoin</h2>
    <p class="sub">${tr('Only money that goes out of date like a newspaper, rots like potatoes, rusts like iron, is fit to be a medium of exchange.')}<br><span class="cite">— ${tr('Silvio Gesell')}</span></p>
    <button id="wCreate">${tr('Sign up')}</button>
    <button id="wRestore" class="ghost">${tr('Log in')}</button>
    <select id="wLang" class="wlang">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${getLang() === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div></div>`;
  $('#wLang').onchange = () => { setLang($('#wLang').value); renderWelcome(); };
  $('#wCreate').onclick = renderSignup;
  $('#wRestore').onclick = renderLogin;
}

// Sign-up and log-in live on their own screens; ← returns to the welcome card.
const authScreen = (title, body) => {
  $('#app').innerHTML = `<div class="lock"><div class="lockcard">
    <div class="lockicon fmark" aria-hidden="true">ƒ</div><h2>${title}</h2>
    <div id="wBody">${body}</div>
    <button id="wBack" class="ghost">← ${tr('Back')}</button></div></div>`;
  $('#wBack').onclick = renderWelcome;
};

function renderSignup() {
  const m = generateMnemonic();
  authScreen(tr('Sign up'), `
    <div class="addr">${m}</div>
    <p class="warn">${tr('⚠ Write these 12 words down. They are the ONLY key to your money — no one can recover them for you.')}</p>
    <div class="row"><button id="wCopy" class="ghost">⧉ ${tr('Copy')}</button><button id="wDone">${tr('I wrote them down')}</button></div>`);
  $('#wCopy').onclick = e => copy(m, e.target);
  $('#wDone').onclick = () => {
    d.recordNewWalletBirth(m);
    welcomePassStep(m, tr('wallet created — you can add a passphrase in Settings 🔒').split(' — ')[0]);
  };
}

function renderLogin() {
  authScreen(tr('Log in'), `
    <label>${tr('Recovery phrase or hex seed')}<textarea id="wSeed" rows="2"></textarea></label>
    <p class="sub">${tr('Restoring an existing wallet scans its whole history once — this can take a minute.')}</p>
    <div class="row"><button id="wGo">${tr('Log in')}</button></div>`);
  $('#wGo').onclick = () => {
    const sec = $('#wSeed').value.trim();
    try { resolveSecret(sec); } catch (e) { return toast(e.message, 'err'); }
    store.set('fw_seed', sec); d.setSecret(sec);
    d.renderApp(); toast(tr('wallet restored — scanning its history…'));
  };
}

// ---------- lock screen ----------
export function renderLock() {
  $('#app').innerHTML = `<div class="lock">
    <div class="lockcard">
      <div class="lockicon">🔒</div><h2>${tr('Unlock wallet')}</h2>
      <input id="pw" type="password" placeholder="${tr('passphrase')}" autofocus>
      <button id="unlockBtn">${tr('Unlock')}</button><p id="lerr" class="err"></p>
    </div></div>`;
  const go = () => {
    const pw = $('#pw').value; if (!pw) return;
    $('#unlockBtn').disabled = true; $('#unlockBtn').textContent = tr('unlocking…'); $('#lerr').textContent = '';
    setTimeout(() => {
      try { d.setSecret(decryptSecret(d.getVault(), pw), pw); d.renderApp(); }
      catch { $('#lerr').textContent = tr('wrong passphrase'); $('#unlockBtn').disabled = false; $('#unlockBtn').textContent = tr('Unlock'); }
    }, 30);
  };
  $('#unlockBtn').onclick = go;
  $('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}
