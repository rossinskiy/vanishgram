// Fails when `npm audit` reports a HIGH or CRITICAL advisory that is not on the reviewed list below.
// Usage: npm audit --omit=dev --json | node scripts/audit-gate.mjs
//
// Reviewed and accepted (both arrive only through @signalapp/libsignal-client -> @signalapp/types, which pins exact versions we cannot override):
//  * GHSA-mrhx-c7xc-m3w5 (zod: memory exhaustion validating oversized collections). zod is used by that package for type definitions;
//    we never pass untrusted data through its validators, and the server (the only network-facing part) does not load it.
//  * GHSA-w5hq-g745-h8pq (uuid: bounds check in v3/v5/v6 when a buffer is supplied). We never call those functions.
// Remove an entry as soon as libsignal ships a fixed dependency.
const ACCEPTED = new Set(['GHSA-mrhx-c7xc-m3w5', 'GHSA-w5hq-g745-h8pq']);
let raw = '';
for await (const c of process.stdin) raw += c;
const report = JSON.parse(raw || '{}');
const bad = [];
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  if (!['high', 'critical'].includes(v.severity)) continue;
  const advisories = (v.via ?? []).filter((x) => typeof x === 'object');
  const urls = advisories.map((a) => String(a.url ?? '').split('/').pop());
  if (advisories.length && urls.every((u) => ACCEPTED.has(u))) continue; // only accepted advisories
  if (!advisories.length) continue; // reported through a dependency that is itself listed
  bad.push(`${name} (${v.severity}): ${urls.join(', ')}`);
}
if (bad.length) { console.error('Unreviewed high/critical vulnerabilities:\n  ' + bad.join('\n  ')); process.exit(1); }
console.log('audit gate: no unreviewed high or critical advisories');
