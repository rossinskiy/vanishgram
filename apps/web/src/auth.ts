import { VanishClient, IdbBackend, newMnemonic, isValidMnemonic, normalizeMnemonic, deriveAccount, WrongPassphraseError } from '@vanishgram/client-core';
import { h, passwordField, copyText, confirmModal, icon } from './dom.ts';
import { askSecondFactor } from './profile-ui.ts';

/** The API origin. In the desktop app the page itself comes from app://vanishgram, so the server address is fixed. */
export const BASE = location.protocol === 'app:' ? 'https://vanishgram.karatel.win' : location.origin;

const year = new Date().getFullYear();
const footer = () => h('footer', { class: 'foot' },
  h('a', { href: '/privacy' }, 'Privacy Policy'), h('a', { href: '/terms' }, 'Terms and Conditions'),
  h('div', {}, `© ${year} Vanishgram`));

const brand = () => h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '', width: '40', height: '40' }), h('span', {}, 'Vanishgram'));

function shell(content: (Node | null)[]): HTMLElement {
  return h('div', { class: 'auth' }, h('main', { id: 'main', class: 'auth-card', tabindex: '-1' }, brand(), ...content.filter((x): x is Node => !!x)), footer());
}

async function busy<T>(btn: HTMLButtonElement, label: string, fn: () => Promise<T>): Promise<T> {
  const old = btn.textContent;
  btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` ${label}`);
  await new Promise((r) => setTimeout(r, 40)); // let the browser paint before heavy work
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}

const errorBox = () => h('p', { class: 'msg-error', role: 'alert' });
function fail(box: HTMLElement, text: string) { box.textContent = text; }

export type Ready = (c: VanishClient) => void;

export interface AuthOptions { add?: boolean; onCancel?: () => void; signedIn?: () => Set<string>; labelOf?: (id: string) => string; lastId?: string | null }

export async function startAuth(root: HTMLElement, ready: Ready, opts: AuthOptions = {}) {
  const show = (n: Node) => { root.replaceChildren(n); (root.querySelector('#main') as HTMLElement | null)?.focus({ preventScroll: true }); };
  let ids: string[] = [];
  if (!opts.add) { try { ids = await IdbBackend.list(); } catch { /* storage blocked: fall through to welcome */ } }

  const welcome = () => show(shell([
    h('h1', {}, 'Private messaging without a phone number'),
    h('p', { class: 'lead' }, 'Messages are encrypted on your device. The server only relays data it cannot read. No email, no phone, no name.'),
    h('div', { class: 'stack' },
      h('button', { class: 'btn block', type: 'button', onClick: create }, 'Create an anonymous account'),
      h('button', { class: 'btn secondary block', type: 'button', onClick: recover }, 'Sign in with a recovery phrase'),
      ids.length ? h('button', { class: 'linkbtn', type: 'button', onClick: () => unlock(ids[0]!) }, 'Unlock this device') : null,
      opts.add ? h('button', { class: 'linkbtn', type: 'button', onClick: () => opts.onCancel?.() }, 'Cancel and go back') : null),
  ]));

  // ---------- create ----------
  function create() {
    const mnemonic = newMnemonic();
    const words = mnemonic.split(' ');
    const phraseStep = () => {
      const saved = h('input', { id: 'saved', type: 'checkbox' });
      const next = h('button', { class: 'btn block', type: 'button', disabled: true, onClick: verifyStep }, 'Continue');
      saved.addEventListener('change', () => { next.disabled = !saved.checked; });
      show(shell([
        h('div', { class: 'steps', 'aria-hidden': 'true' }, h('i', { class: 'on' }), h('i'), h('i')),
        h('h1', {}, 'Your recovery phrase'),
        h('div', { class: 'notice warn' }, 'These 12 words are the only way to recover your account. Anyone who has them controls your account. If you lose them and all your signed-in devices, the account cannot be recovered. We never receive them.'),
        h('ol', { class: 'words', 'aria-label': 'Recovery phrase, 12 words' }, words.map((w) => h('li', {}, w))),
        h('button', { class: 'btn secondary block', type: 'button', onClick: () => copyText(mnemonic, 'Phrase copied. Paste it somewhere safe, then clear your clipboard.') }, icon('copy'), ' Copy phrase'),
        h('label', { class: 'check', for: 'saved' }, saved, h('span', {}, 'I wrote down my recovery phrase and stored it somewhere safe.')),
        next,
        h('button', { class: 'linkbtn', type: 'button', onClick: welcome }, 'Back'),
      ]));
    };
    const verifyStep = () => {
      const pos = Array.from({ length: 12 }, (_, i) => i).sort(() => crypto.getRandomValues(new Uint8Array(1))[0]! - 128).slice(0, 3).sort((a, b) => a - b);
      const inputs = pos.map((p) => h('input', { class: 'input', id: `w${p}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }));
      const err = errorBox();
      const go = h('button', { class: 'btn block', type: 'button', onClick: () => {
        if (pos.every((p, i) => inputs[i]!.value.trim().toLowerCase() === words[p])) passStep(); else fail(err, 'One of the words does not match. Check your written phrase.');
      } }, 'Continue');
      show(shell([
        h('div', { class: 'steps', 'aria-hidden': 'true' }, h('i', { class: 'on' }), h('i', { class: 'on' }), h('i')),
        h('h1', {}, 'Check your backup'),
        h('p', { class: 'lead' }, 'Enter these words from your written phrase.'),
        ...pos.map((p, i) => h('div', { class: 'field' }, h('label', { for: `w${p}` }, `Word ${p + 1}`), inputs[i]!)),
        err, go, h('button', { class: 'linkbtn', type: 'button', onClick: phraseStep }, 'Show phrase again'),
      ]));
    };
    const passStep = () => {
      const p1 = passwordField('p1', 'Passphrase for this device', { autocomplete: 'new-password', hint: 'At least 8 characters. It encrypts your keys and messages stored in this browser.' });
      const p2 = passwordField('p2', 'Repeat passphrase', { autocomplete: 'new-password' });
      const err = errorBox();
      const go = h('button', { class: 'btn block', type: 'button', onClick: async () => {
        err.textContent = '';
        if (p1.input.value.length < 8) return fail(err, 'Use at least 8 characters.');
        if (p1.input.value !== p2.input.value) return fail(err, 'The passphrases do not match.');
        try {
          await busy(go, 'Creating account', async () => {
            const { client } = await VanishClient.register(BASE, mnemonic);
            await client.attachVault(new IdbBackend(client.account.accountId), p1.input.value);
            ready(client);
          });
        } catch (e) { fail(err, (e as any)?.status === 429 ? 'Too many sign-ups from this network. Try again later.' : 'Could not create the account. Check your connection and try again.'); }
      } }, 'Create account');
      show(shell([
        h('div', { class: 'steps', 'aria-hidden': 'true' }, h('i', { class: 'on' }), h('i', { class: 'on' }), h('i', { class: 'on' })),
        h('h1', {}, 'Protect this device'), p1.wrap, p2.wrap, err, go,
      ]));
    };
    phraseStep();
  }

  // ---------- recover ----------
  function recover() {
    const phrase = h('textarea', { class: 'input', id: 'phrase', rows: '3', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'word1 word2 word3 ...' });
    const pw = passwordField('rp', 'New passphrase for this device', { autocomplete: 'new-password', hint: 'At least 8 characters. Only used on this device.' });
    const err = errorBox();
    const go = h('button', { class: 'btn block', type: 'button', onClick: async () => {
      err.textContent = '';
      const m = normalizeMnemonic(phrase.value);
      if (!isValidMnemonic(m)) return fail(err, 'That is not a valid 12-word recovery phrase.');
      if (opts.signedIn?.().has(deriveAccount(m).accountId)) return fail(err, 'This account is already signed in on this device. Switch to it from the menu.');
      if (pw.input.value.length < 8) return fail(err, 'Use at least 8 characters for the passphrase.');
      try {
        await busy(go, 'Signing in', async () => {
          const client = await VanishClient.recover(BASE, m, askSecondFactor);
          await client.attachVault(new IdbBackend(client.account.accountId), pw.input.value);
          ready(client);
        });
      } catch (e) { fail(err, (e as any)?.code === 'cancelled' ? 'Sign-in cancelled.' : (e as any)?.status === 429 ? 'Too many wrong attempts. Try again in a few minutes.' : 'Sign-in failed. Check the phrase and your connection.'); }
    } }, 'Sign in');
    show(shell([
      h('h1', {}, 'Sign in'),
      h('p', { class: 'lead' }, 'Enter your 12-word recovery phrase. It stays on this device. Only a signature is sent.'),
      h('div', { class: 'notice' }, 'Signing in on a new device does not restore old messages. They live only on the devices that received them.'),
      h('div', { class: 'field' }, h('label', { for: 'phrase' }, 'Recovery phrase'), phrase), pw.wrap, err, go,
      h('button', { class: 'linkbtn', type: 'button', onClick: welcome }, 'Back'),
    ]));
  }

  // ---------- unlock ----------
  function unlock(id: string) {
    const pw = passwordField('up', 'Passphrase', { autocomplete: 'current-password' });
    const err = errorBox();
    const go = h('button', { class: 'btn block', type: 'button', onClick: async () => {
      err.textContent = '';
      try {
        await busy(go, 'Unlocking', async () => {
          const c = await VanishClient.open(BASE, new IdbBackend(id), pw.input.value, askSecondFactor);
          if (!c) throw new Error('missing');
          ready(c);
        });
      } catch (e) { fail(err, e instanceof WrongPassphraseError ? 'Wrong passphrase.' : (e as any)?.code === 'cancelled' ? 'Sign-in cancelled.' : (e as any)?.status === 429 ? 'Too many wrong attempts. Try again in a few minutes.' : 'Could not unlock. Check your connection and try again.'); }
    } }, 'Unlock');
    pw.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    show(shell([
      h('h1', {}, 'Welcome back'),
      h('p', { class: 'lead' }, 'Enter your device passphrase to open your chats.'),
      pw.wrap, err, go,
      ids.length > 1 ? h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Other accounts on this device'), ...ids.filter((x) => x !== id).map((x) => h('button', { class: 'btn secondary', type: 'button', onClick: () => unlock(x) }, opts.labelOf?.(x) ?? `Account ${x.slice(0, 8)}`))) : null,
      h('button', { class: 'linkbtn', type: 'button', onClick: async () => {
        if (await confirmModal('Remove this device data?', 'This deletes the encrypted data stored in this browser. You can sign in again with your recovery phrase, but old messages will not come back.', 'Remove data')) {
          await new IdbBackend(id).remove(); ids = ids.filter((x) => x !== id); welcome();
        }
      } }, 'Forgot passphrase? Remove this device data'),
    ]));
  }

  if (ids.length && !opts.add) unlock(opts.lastId && ids.includes(opts.lastId) ? opts.lastId : ids[0]!); else welcome();
}
