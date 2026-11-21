// Signature check for update descriptions. No Electron imports, so tests and the release script can use it too.
'use strict';
const crypto = require('node:crypto');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** The exact bytes that are signed: version plus every file name and sha512, sorted. */
const canonical = (r) => `vanishgram-release\n${r.version}\n` + [...r.files].map((f) => `${f.name}:${f.sha512}`).sort().join('\n');

function verifyRelease(r, publicKeyB64) {
  try {
    if (!r || typeof r.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(r.version) || !Array.isArray(r.files) || typeof r.sig !== 'string') return false;
    if (!r.files.every((f) => f && typeof f.name === 'string' && typeof f.sha512 === 'string')) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKeyB64, 'base64')]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(canonical(r)), key, Buffer.from(r.sig, 'base64'));
  } catch { return false; }
}
module.exports = { canonical, verifyRelease };
