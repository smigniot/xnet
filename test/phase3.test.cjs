/* Node tests for Phase 3: gun mesh adapter + encrypted CRDT sync.
   gun runs in Node, so the sync engine is verified for real (not just eyeballed).
   Run: `node test/phase3.test.cjs`. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
// Use the full gun build (it includes the storage adapter gun needs to function). Run in a
// temp cwd so gun's Node radisk store writes there, and clean it up at the end.
const RADATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xnet-gun-'));
process.chdir(RADATA);
const Gun = require(path.join(__dirname, '..', 'node_modules', 'gun'));

globalThis.self = globalThis;
const { webcrypto } = require('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const SRC = path.join(__dirname, '..', 'src');
const naclCode = fs.readFileSync(path.join(SRC, 'vendor', 'nacl.min.js'), 'utf8');
const shim = { exports: {} };
new Function('module', 'exports', 'self', 'window', naclCode)(shim, shim.exports, globalThis, undefined);
globalThis.nacl = shim.exports.randomBytes ? shim.exports : globalThis.nacl;
const load = (f) => (0, eval)(fs.readFileSync(path.join(SRC, f), 'utf8'));
load('identity.js'); load('mesh.js'); load('sync.js');
const X = globalThis.Xnet;

let nodeSeq = 0;
function node() { return X.mesh.create(Gun, { gun: { file: path.join(RADATA, 'n' + (nodeSeq++)) } }); }
function wire(m1, m2) { const [a, b] = X.mesh.stubPair(); m1.addLink(a); m2.addLink(b); }
function cleanup() { try { process.chdir(os.tmpdir()); fs.rmSync(RADATA, { recursive: true, force: true }); } catch (e) {} }
function waitFor(pred, ms) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() {
      let v; try { v = pred(); } catch (e) { v = false; }
      if (v) return res(v);
      if (Date.now() - t0 > (ms || 3000)) return rej(new Error('timeout'));
      setTimeout(poll, 25);
    })();
  });
}

(async () => {
  const id = X.crypto.newIdentity();
  const roomId = X.crypto.uuid();
  const secret = X.crypto.newRoomSecret();

  // ---- 1) two nodes, encrypted message syncs and decrypts ----
  {
    const A = node(), B = node(); wire(A, B);
    const got = new Map();
    X.sync.onMessage(B.gun, roomId, secret, {}, (m) => got.set(m.id, m));
    const sent = X.sync.publishMessage(A.gun, roomId, secret, id, 'hello over the mesh');
    await waitFor(() => got.has(sent.id), 3000);
    const m = got.get(sent.id);
    assert.strictEqual(m.text, 'hello over the mesh', 'B decrypts A\'s message');
    assert.strictEqual(m.authorPub, id.signPk, 'authorPub preserved');
    assert(m.verified, 'signature verifies');
    console.log('  [1] 2-node encrypted sync OK');
  }

  // ---- 2) a connected NON-member (wrong secret) sees ciphertext only ----
  {
    const A = node(), B = node(); wire(A, B);
    const wrong = X.crypto.newRoomSecret();
    const seen = new Map();
    X.sync.onMessage(B.gun, roomId, wrong, {}, (m) => seen.set(m.id, m));
    const sent = X.sync.publishMessage(A.gun, roomId, secret, id, 'top secret');
    await waitFor(() => seen.has(sent.id), 3000);
    const m = seen.get(sent.id);
    assert.strictEqual(m.text, null, 'non-member cannot decrypt (text=null)');
    assert(m.verified, 'but can still verify authorship'); // sig is over ciphertext
    console.log('  [2] content sealed to non-members OK');
  }

  // ---- 3) transitive relay A—B—C (A not linked to C) ----
  {
    const A = node(), B = node(), Cn = node();
    wire(A, B); wire(B, Cn);                 // B has two links; C only knows B
    const got = new Map();
    X.sync.onMessage(Cn.gun, roomId, secret, {}, (m) => got.set(m.id, m));
    const sent = X.sync.publishMessage(A.gun, roomId, secret, id, 'reaches C through B');
    await waitFor(() => got.has(sent.id), 4000);
    assert.strictEqual(got.get(sent.id).text, 'reaches C through B', 'transitive relay via B');
    console.log('  [3] transitive relay through a middle node OK');
  }

  // ---- 4) sticky horizon filter drops messages older than the horizon ----
  {
    const A = node(), B = node(); wire(A, B);
    const sent = X.sync.publishMessage(A.gun, roomId, secret, id, 'old message');
    const delivered = [];
    // horizon far in the future relative to this message -> must be filtered out
    X.sync.onMessage(B.gun, roomId, secret, { horizon: () => sent.ts + 1e9 }, (m) => delivered.push(m));
    // give it time; also confirm the SAME node delivers when horizon is 0
    const ok = [];
    X.sync.onMessage(B.gun, roomId, secret, { horizon: () => 0 }, (m) => { if (m.id === sent.id) ok.push(m); });
    await waitFor(() => ok.length > 0, 3000);
    assert.strictEqual(delivered.length, 0, 'message below horizon is filtered');
    console.log('  [4] sticky horizon filter OK');
  }

  console.log('PHASE 3 TESTS OK');
  cleanup(); process.exit(0);
})().catch((e) => { cleanup(); console.error('TEST FAIL:', e && e.stack || e); process.exit(1); });
