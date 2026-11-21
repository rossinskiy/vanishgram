import qrcode from 'qrcode-generator';
import type { VanishClient, SecondFactorAnswer, SecondFactorRequest, Privacy, DeviceInfo, ReportKind, ChatMessage } from '@vanishgram/client-core';
import { h, icon, toast, copyText, modal, confirmModal, passwordField } from './dom.ts';

const initialOf = (c: VanishClient, id: string) => (c.contacts.get(id)?.displayName || c.contacts.get(id)?.username || id).slice(0, 1).toUpperCase();

/** Stable colour per account or chat, from a brand-friendly set (no purple). */
export function colorClass(id: string): string { let n = 0; for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) >>> 0; return `av-${n % 7}`; }

const avatarUrls = new Map<string, string>();

/** Round avatar: the initial first, the picture as soon as it is loaded. */
export function avatarEl(c: VanishClient, id: string, cls = 'avatar'): HTMLElement {
  const el = h('span', { class: `${cls} ${colorClass(id)}` }, initialOf(c, id));
  const version = id === c.account.accountId ? c.profile.me.avatarVersion : c.contacts.get(id)?.avatarVersion ?? 0;
  if (version) {
    const key = `${id}:${version}`, hit = avatarUrls.get(key);
    const put = (url: string) => el.replaceChildren(h('img', { src: url, alt: '', class: 'avatar-img', decoding: 'async', loading: 'lazy' }));
    if (hit) put(hit);
    else void c.profile.avatar(id, version).then((bytes) => {
      if (!bytes) return;
      const url = avatarUrls.get(key) ?? URL.createObjectURL(new Blob([bytes as BlobPart])); // one object URL per picture, reused by every row
      avatarUrls.set(key, url); put(url);
    });
  }
  return el;
}

/** Centre-crop to a 256 px square and re-encode. Re-encoding also removes EXIF data such as GPS. */
export async function cropAvatar(file: File): Promise<Uint8Array> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  canvas.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
  const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.85));
  const out = blob && blob.type === 'image/webp' ? blob : await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  if (!out) throw new Error('could not encode image');
  return new Uint8Array(await out.arrayBuffer());
}

export function editProfileDialog(c: VanishClient, onDone: () => void) {
  const me = c.profile.me;
  const name = h('input', { class: 'input', id: 'pf-name', maxlength: '64', autocomplete: 'off', value: me.displayName });
  const bio = h('textarea', { class: 'input', id: 'pf-bio', rows: '3', maxlength: '100' });
  bio.value = me.bio;
  const count = h('span', { class: 'muted small', 'aria-live': 'polite' }, `${[...me.bio].length}/100`);
  bio.addEventListener('input', () => { count.textContent = `${[...bio.value].length}/100`; });
  const err = h('p', { class: 'msg-error', role: 'alert' });
  const preview = h('div', { class: 'row mb16' });
  const refresh = () => preview.replaceChildren(avatarEl(c, c.account.accountId, 'avatar lg'),
    h('div', { class: 'grow' }, h('label', { class: 'btn secondary small-btn', for: 'pf-file' }, 'Choose photo'),
      c.profile.me.avatarVersion ? h('button', { class: 'btn secondary small-btn', type: 'button', onClick: async () => { await c.profile.removeAvatar(); refresh(); onDone(); } }, 'Remove') : null));
  const file = h('input', { type: 'file', id: 'pf-file', accept: 'image/png,image/jpeg,image/webp', class: 'sr-only', onChange: async () => {
    const f = (file as HTMLInputElement).files?.[0]; if (!f) return;
    (file as HTMLInputElement).value = ''; // so choosing the same file again still counts as a change
    try { await c.profile.setAvatar(await cropAvatar(f)); refresh(); onDone(); } catch { err.textContent = 'That image could not be used. Try a PNG, JPEG or WebP photo.'; }
  } });
  refresh();
  const m = modal('Edit profile', [h('form', { onSubmit: async (e: Event) => {
    e.preventDefault(); err.textContent = '';
    try { await c.profile.update({ displayName: name.value.trim(), bio: bio.value }); onDone(); m.close(); toast('Profile saved'); }
    catch (e2) { err.textContent = (e2 as Error).message.includes('limited') ? 'The bio can have at most 100 characters.' : 'Could not save your profile.'; }
  } }, preview, file,
    h('div', { class: 'field' }, h('label', { for: 'pf-name' }, 'Display name'), name),
    h('div', { class: 'field' }, h('label', { for: 'pf-bio' }, 'Bio'), bio, count),
    h('p', { class: 'muted small' }, 'Your photo, name and bio are visible to others according to your privacy settings. They are stored on the server and are not end-to-end encrypted.'),
    err, h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save'), h('button', { class: 'btn secondary', type: 'button', onClick: () => m.close() }, 'Cancel')))]);
}

export function privacyDialog(c: VanishClient, personLabel: (id: string) => string) {
  const p = c.profile.me.privacy;
  const sel = (id: string, label: string, key: keyof Privacy, options: [string, string][]) => {
    const s = h('select', { class: 'input', id }, options.map(([v, t]) => h('option', { value: v }, t)));
    s.value = String(p[key]);
    s.addEventListener('change', () => { void c.profile.setPrivacy({ [key]: s.value } as Partial<Privacy>).catch(() => toast('Could not save.')); });
    return h('div', { class: 'field' }, h('label', { for: id }, label), s);
  };
  const chk = (id: string, label: string, key: 'typing' | 'readReceipts') => {
    const i = h('input', { type: 'checkbox', id, checked: !!p[key], onChange: () => { void c.profile.setPrivacy({ [key]: (i as HTMLInputElement).checked } as Partial<Privacy>).catch(() => toast('Could not save.')); } });
    return h('label', { class: 'check', for: id }, i, h('span', {}, label));
  };
  const blockedBox = h('ul', { class: 'members' });
  const loadBlocked = async () => {
    const ids = await c.profile.blocked().catch(() => [] as string[]);
    for (const id of ids.slice(0, 30)) await c.resolveContact(id).catch(() => {});
    blockedBox.replaceChildren(...(ids.length ? ids.map((id) => h('li', {}, avatarEl(c, id, 'avatar alt'), h('span', { class: 'grow name' }, personLabel(id)),
      h('button', { class: 'btn secondary small-btn', type: 'button', onClick: async () => { await c.profile.unblock(id); void loadBlocked(); } }, 'Unblock')))
      : [h('li', { class: 'muted small' }, 'You have not blocked anyone.')]));
  };
  const m = modal('Privacy and blocking', [
    sel('pv-seen', 'Who can see when I was last online', 'lastSeen', [['everyone', 'Everyone'], ['contacts', 'People I have written to'], ['nobody', 'Nobody']]),
    sel('pv-prof', 'Who can see my photo, name and bio', 'profile', [['everyone', 'Everyone'], ['contacts', 'People I have written to']]),
    sel('pv-inv', 'Who can add me to groups and channels', 'invites', [['everyone', 'Everyone'], ['contacts', 'People I have written to'], ['nobody', 'Nobody']]),
    sel('pv-unk', 'Who can send me messages', 'unknownMessages', [['allow', 'Everyone'], ['contacts', 'Only people I have written to']]),
    chk('pv-typing', 'Show others when I am typing', 'typing'),
    chk('pv-read', 'Let others see when I have read their messages', 'readReceipts'),
    h('p', { class: 'muted small' }, 'Blocked people can still try to write: it looks sent to them, but nothing reaches you and they are not told. Hidden last-online and profile settings apply to them too.'),
    h('div', { class: 'section' }, h('h3', {}, 'Blocked people'), blockedBox),
    h('button', { class: 'btn secondary block mt14', type: 'button', onClick: () => m.close() }, 'Close'),
  ]);
  void loadBlocked();
}

function codeDisplay(codes: string[]): Node {
  const text = codes.join('\n');
  return h('div', {}, h('ul', { class: 'words codes' }, codes.map((c) => h('li', {}, c))),
    h('div', { class: 'row wrap' }, h('button', { class: 'btn secondary', type: 'button', onClick: () => copyText(text, 'Recovery codes copied') }, icon('copy'), ' Copy codes')));
}

export function securityDialog(c: VanishClient) {
  const body = h('div', {});
  const m = modal('Security', [body, h('button', { class: 'btn secondary block mt14', type: 'button', onClick: () => m.close() }, 'Close')]);
  const render = async () => {
    const st = await c.tf.status().catch(() => null);
    if (!st) { body.replaceChildren(h('p', { class: 'msg-error' }, 'Could not load your security settings.')); return; }
    body.replaceChildren(
      h('p', { class: 'muted small' }, 'Two-step verification protects your account if someone learns your 12-word phrase: signing in on a new device then also needs the factors below. It does not change message encryption, and it cannot protect you if the server itself were compromised.'),
      h('div', { class: 'section' }, h('h3', {}, 'Authenticator app'),
        h('p', { class: 'muted small' }, st.totp ? `On. ${st.recoveryCodesLeft} recovery codes left.` : 'Off. Works with Google Authenticator, Microsoft Authenticator and other TOTP apps.'),
        st.totp
          ? h('div', { class: 'row wrap' },
            h('button', { class: 'btn secondary', type: 'button', onClick: () => askCode('Turn off the authenticator', 'Enter the current 6-digit code or a recovery code.', async (v) => { await c.tf.disableTotp(/^\d{6}$/.test(v) ? { code: v } : { recovery: v }); }, render) }, 'Turn off'),
            h('button', { class: 'btn secondary', type: 'button', onClick: () => askCode('New recovery codes', 'Enter the current 6-digit code. Old codes stop working.', async (v) => { showCodes(await c.tf.regenerateRecovery(v)); }, render) }, 'New recovery codes'))
          : h('button', { class: 'btn secondary', type: 'button', onClick: () => setupTotp(render) }, 'Set up authenticator')),
      h('div', { class: 'section' }, h('h3', {}, 'Cloud password'),
        h('p', { class: 'muted small' }, st.password ? 'On. Asked after your recovery phrase on every new sign-in.' : 'Off. An extra password asked after your recovery phrase. It cannot be reset: if you forget it you lose access to the account.'),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn secondary', type: 'button', onClick: () => passwordDialog(st.password, render) }, st.password ? 'Change password' : 'Set password'),
          st.password ? h('button', { class: 'btn secondary', type: 'button', onClick: () => removePasswordDialog(render) }, 'Remove') : null)));
  };

  function showCodes(codes: string[]) {
    const d = modal('Save your recovery codes', [h('p', { class: 'muted' }, 'Each code works once if you lose your authenticator. Store them somewhere safe and private. They are shown only now.'), codeDisplay(codes),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: () => d.close() }, 'I saved them'))]);
  }

  function askCode(title: string, help: string, run: (v: string) => Promise<void>, after: () => void) {
    const input = h('input', { class: 'input', id: 'sec-code', autocomplete: 'one-time-code', inputmode: 'text', autocapitalize: 'off', spellcheck: 'false' });
    const err = h('p', { class: 'msg-error', role: 'alert' });
    const d = modal(title, [h('form', { onSubmit: async (e: Event) => { e.preventDefault(); err.textContent = ''; try { await run(input.value.trim()); d.close(); after(); } catch (e2) { err.textContent = (e2 as any)?.status === 429 ? 'Too many attempts. Wait a minute.' : 'That code is not correct.'; } } },
      h('p', { class: 'muted' }, help), h('div', { class: 'field' }, h('label', { for: 'sec-code' }, 'Code'), input), err,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Confirm'), h('button', { class: 'btn secondary', type: 'button', onClick: () => d.close() }, 'Cancel')))]);
  }

  async function setupTotp(after: () => void) {
    let setup: { secret: string; uri: string };
    try { setup = await c.tf.setupTotp(); } catch { toast('Could not start the setup.'); return; }
    const qr = qrcode(0, 'M'); qr.addData(setup.uri); qr.make();
    const input = h('input', { class: 'input', id: 'totp-confirm', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '123456' });
    const err = h('p', { class: 'msg-error', role: 'alert' });
    const d = modal('Set up authenticator', [h('form', { onSubmit: async (e: Event) => {
      e.preventDefault(); err.textContent = '';
      try { const codes = await c.tf.enableTotp(input.value.trim()); d.close(); showCodes(codes); after(); }
      catch (e2) { err.textContent = (e2 as any)?.status === 429 ? 'Too many attempts. Wait a minute.' : 'That code is not correct. Check the time on your phone.'; }
    } },
      h('p', { class: 'muted' }, '1. Scan this code with your authenticator app, or type the key by hand.'),
      h('div', { class: 'qr' }, h('img', { src: qr.createDataURL(5, 3), alt: 'QR code for your authenticator app', width: '200', height: '200' })),
      h('div', { class: 'kv' }, h('code', { 'aria-label': 'Setup key' }, setup.secret.match(/.{1,4}/g)!.join(' '))),
      h('p', { class: 'muted' }, '2. Enter the 6-digit code it shows.'),
      h('div', { class: 'field' }, h('label', { for: 'totp-confirm' }, 'Code'), input), err,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Turn on'), h('button', { class: 'btn secondary', type: 'button', onClick: () => d.close() }, 'Cancel')))]);
  }

  function passwordDialog(has: boolean, after: () => void) {
    const cur = has ? passwordField('pw-cur', 'Current password', { autocomplete: 'current-password' }) : null;
    const p1 = passwordField('pw-new', 'New password', { autocomplete: 'new-password', hint: 'At least 10 characters. If you forget it, the account cannot be recovered.' });
    const p2 = passwordField('pw-new2', 'Repeat new password', { autocomplete: 'new-password' });
    const err = h('p', { class: 'msg-error', role: 'alert' });
    const go = h('button', { class: 'btn', type: 'submit' }, 'Save password');
    const d = modal(has ? 'Change cloud password' : 'Set cloud password', [h('form', { onSubmit: async (e: Event) => {
      e.preventDefault(); err.textContent = '';
      if (p1.input.value !== p2.input.value) return void (err.textContent = 'The passwords do not match.');
      go.disabled = true;
      try { await c.tf.setPassword(p1.input.value, cur?.input.value); d.close(); after(); toast('Cloud password saved'); }
      catch (e2) { err.textContent = (e2 as any)?.status === 401 ? 'The current password is not correct.' : (e2 as any)?.status === 429 ? 'Too many attempts. Wait a minute.' : (e2 as Error).message.includes('at least') ? 'Use at least 10 characters.' : 'Could not save the password.'; go.disabled = false; }
    } }, cur?.wrap ?? null, p1.wrap, p2.wrap, err, h('div', { class: 'actions' }, go, h('button', { class: 'btn secondary', type: 'button', onClick: () => d.close() }, 'Cancel')))]);
  }

  function removePasswordDialog(after: () => void) {
    const cur = passwordField('pw-rm', 'Current password', { autocomplete: 'current-password' });
    const err = h('p', { class: 'msg-error', role: 'alert' });
    const d = modal('Remove cloud password', [h('form', { onSubmit: async (e: Event) => { e.preventDefault(); err.textContent = ''; try { await c.tf.removePassword(cur.input.value); d.close(); after(); } catch { err.textContent = 'The password is not correct.'; } } },
      cur.wrap, err, h('div', { class: 'actions' }, h('button', { class: 'btn danger', type: 'submit' }, 'Remove'), h('button', { class: 'btn secondary', type: 'button', onClick: () => d.close() }, 'Cancel')))]);
  }
  void render();
}

/** Asked during sign-in when the account has two-step verification on. Resolves to null if cancelled. */
export function askSecondFactor(req: SecondFactorRequest): Promise<SecondFactorAnswer | null> {
  return new Promise((resolve) => {
    let done = false, useRecovery = false;
    const code = h('input', { class: 'input', id: 'sf-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '123456' });
    const rec = h('input', { class: 'input', id: 'sf-rec', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'xxxxx-xxxxx' });
    const pw = req.password ? passwordField('sf-pw', 'Cloud password', { autocomplete: 'current-password' }) : null;
    const codeField = h('div', { class: 'field' }, h('label', { for: 'sf-code' }, 'Authenticator code'), code);
    const recField = h('div', { class: 'field', hidden: true }, h('label', { for: 'sf-rec' }, 'Recovery code'), rec);
    const toggle = h('button', { class: 'linkbtn', type: 'button', onClick: () => { useRecovery = !useRecovery; codeField.hidden = useRecovery; recField.hidden = !useRecovery; toggle.textContent = useRecovery ? 'Use my authenticator app' : 'Use a recovery code instead'; (useRecovery ? rec : code).focus(); } }, 'Use a recovery code instead');
    const finish = (v: SecondFactorAnswer | null) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal('Two-step verification', [h('form', { onSubmit: (e: Event) => { e.preventDefault(); finish({ ...(req.totp ? (useRecovery ? { recovery: rec.value.trim() } : { totp: code.value.trim() }) : {}), ...(pw ? { password: pw.input.value } : {}) }); } },
      req.attempt > 0 ? h('p', { class: 'msg-error', role: 'alert' }, 'That did not match. Check and try again.') : null,
      h('p', { class: 'muted' }, 'This account needs more than the recovery phrase to sign in on a new device.'),
      req.totp ? codeField : null, req.totp ? recField : null, pw?.wrap ?? null, req.totp ? toggle : null,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Continue'), h('button', { class: 'btn secondary', type: 'button', onClick: () => finish(null) }, 'Cancel')))], { onClose: () => finish(null) });
  });
}

/** A coarse, human description of this browser. Nothing here identifies the person. */
export function uaLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown system';
  return `${browser} on ${os}`;
}

const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? 'Active now' : s < 3600 ? `${Math.round(s / 60)} minutes ago` : s < 86400 ? `${Math.round(s / 3600)} hours ago` : `${Math.round(s / 86400)} days ago`; };

export function devicesDialog(c: VanishClient) {
  const box = h('ul', { class: 'members' });
  const m = modal('Devices', [
    h('p', { class: 'muted small' }, 'Every device that is signed in to this account. If you do not recognise one, sign it out and consider changing your two-step verification.'),
    box,
    h('div', { class: 'actions' }, h('button', { class: 'btn secondary', type: 'button', onClick: async () => {
      if (!(await confirmModal('Sign out all other devices?', 'Every other device is signed out right away and its encrypted data on that device is removed. This device stays signed in.', 'Sign out others'))) return;
      try { const r = await c.profile.revokeOtherDevices(); toast(r.revoked ? `Signed out ${r.revoked} device${r.revoked === 1 ? '' : 's'}` : 'No other devices'); await draw(); } catch { toast('Could not sign them out.'); }
    } }, 'Sign out all other devices'), h('button', { class: 'btn secondary', type: 'button', onClick: () => m.close() }, 'Close')),
  ]);
  async function draw() {
    let list: DeviceInfo[];
    try { list = await c.profile.devices(); } catch { box.replaceChildren(h('li', { class: 'msg-error' }, 'Could not load devices.')); return; }
    box.replaceChildren(...list.map((d) => h('li', {}, h('span', { class: 'file-icon' }, icon('lock')), h('span', { class: 'grow' }, h('span', { class: 'name' }, d.label, d.current ? h('span', { class: 'muted small' }, '  this device') : null), h('span', { class: 'muted small role' }, d.current ? 'Active now' : ago(d.lastSeen))),
      d.current ? null : h('button', { class: 'btn secondary small-btn', type: 'button', onClick: async () => {
        if (!(await confirmModal('Sign out this device?', `${d.label} will be signed out and its encrypted data removed.`, 'Sign out'))) return;
        try { await c.profile.revokeDevice(d.deviceId); toast('Device signed out'); await draw(); } catch { toast('Could not sign it out.'); }
      } }, 'Sign out'))));
  }
  void draw();
}

export function reportDialog(c: VanishClient, accountId: string, who: string, recent: ChatMessage[]) {
  const kinds: [ReportKind, string][] = [['spam', 'Spam or unwanted messages'], ['abuse', 'Harassment or abuse'], ['impersonation', 'Pretending to be someone else'], ['illegal', 'Something illegal'], ['other', 'Something else']];
  let kind: ReportKind = 'spam';
  const note = h('textarea', { class: 'input', id: 'rp-note', rows: '3', maxlength: '500', placeholder: 'Add details (optional)' });
  const attach = h('input', { type: 'checkbox', id: 'rp-attach' });
  const sample = recent.filter((x) => !x.sys && x.body).slice(-5);
  const m = modal(`Report ${who}`, [h('form', { onSubmit: async (e: Event) => {
    e.preventDefault();
    try {
      await c.profile.report(accountId, kind, note.value, (attach as HTMLInputElement).checked ? sample.map((x) => ({ from: x.from, ts: x.ts, body: x.body })) : undefined);
      m.close(); toast('Report sent. Thank you.');
    } catch { toast('Could not send the report.'); }
  } },
    h('p', { class: 'muted small' }, 'Messages are end-to-end encrypted, so we cannot see them. A report only says that you flagged this account. You decide whether to attach messages.'),
    h('div', { class: 'choices' }, kinds.map(([k, t]) => h('label', { class: 'check', for: `rk-${k}` }, h('input', { type: 'radio', name: 'rkind', id: `rk-${k}`, checked: k === kind, onChange: () => { kind = k; } }), h('span', {}, t)))),
    h('div', { class: 'field mt14' }, h('label', { for: 'rp-note' }, 'Details'), note),
    sample.length ? h('label', { class: 'check', for: 'rp-attach' }, attach, h('span', {}, `Also send the last ${sample.length} message${sample.length === 1 ? '' : 's'} of this chat to the moderators, readable by them. Nothing else from the chat is sent.`)) : null,
    h('div', { class: 'actions' }, h('button', { class: 'btn danger', type: 'submit' }, 'Send report'), h('button', { class: 'btn secondary', type: 'button', onClick: () => m.close() }, 'Cancel')))]);
}
