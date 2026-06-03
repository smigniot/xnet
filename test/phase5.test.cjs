/* Node tests for Phase 5: meet-once mesh signaling.
   - record crypto (box+sign) roundtrip and rejection of tamper/wrong-recipient
   - full connectTo handshake over TWO real gun nodes, using a FAKE RTCPeerConnection
     (real WebRTC is browser-only). Verifies an offer written to signal/<peer> rides the
     mesh, the peer answers over the mesh, and BOTH sides end up linked — no QR.
   Run: `node test/phase5.test.cjs`. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
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
load('identity.js'); load('mesh.js'); load('sync.js'); load('signaling.js'); load('signal.js');
const X = globalThis.Xnet;

function cleanup() { try { process.chdir(os.tmpdir()); fs.rmSync(RADATA, { recursive: true, force: true }); } catch (e) {} }
let seq = 0;
function node() { return X.mesh.create(Gun, { gun: { file: path.join(RADATA, 'n' + (seq++)) } }); }
function wire(a, b) { const [x, y] = X.mesh.stubPair(); a.addLink(x); b.addLink(y); }
function waitFor(p, ms) { return new Promise((res, rej) => { const t0 = Date.now(); (function go() { let v; try { v = p(); } catch (e) {} if (v) return res(v); if (Date.now() - t0 > (ms || 4000)) return rej(new Error('timeout')); setTimeout(go, 25); })(); }); }

// ---- Fake RTCPeerConnection: no real ICE/DTLS; channels "open" immediately ----
function fakeChannel() {
  const fns = {};
  return {
    readyState: 'open', send() {},
    addEventListener(t, f) { (fns[t] = fns[t] || []).push(f); },
    _emit(t, e) { (fns[t] || []).forEach((f) => f(e)); }
  };
}
function FakePC() { this.localDescription = null; this.iceGatheringState = 'complete'; this.ondatachannel = null; }
FakePC.prototype.addEventListener = function () {};
FakePC.prototype.createDataChannel = function () { return fakeChannel(); };
FakePC.prototype.createOffer = async function () { return { type: 'offer', sdp: 'FAKE_OFFER_' + Math.random() }; };
FakePC.prototype.createAnswer = async function () { return { type: 'answer', sdp: 'FAKE_ANSWER_' + Math.random() }; };
FakePC.prototype.setLocalDescription = async function (d) { this.localDescription = { type: d.type, sdp: d.sdp }; };
FakePC.prototype.setRemoteDescription = async function (d) {
  if (d.type === 'offer') { const ch = fakeChannel(); const self = this; setTimeout(() => { if (self.ondatachannel) self.ondatachannel({ channel: ch }); }, 0); }
};

(async () => {
  const alice = X.crypto.newIdentity();
  const bob = X.crypto.newIdentity();

  // ---- 1) record crypto ----
  {
    const rec = X.signal.makeRecord('offer', 'sid1', alice, bob.boxPk, 'SDP-DATA');
    const opened = X.signal.openRecord(rec, bob);
    assert(opened && opened.sdp === 'SDP-DATA', 'recipient opens the record');
    assert.strictEqual(opened.fromSignPk, alice.signPk, 'authenticated sender');
    assert.strictEqual(X.signal.openRecord(rec, X.crypto.newIdentity()), null, 'wrong recipient cannot open');
    const tampered = Object.assign({}, rec, { enc: rec.enc.slice(1) });
    assert.strictEqual(X.signal.openRecord(tampered, bob), null, 'tampered record rejected');
    console.log('  [1] signal record crypto OK');
  }

  // ---- 2) full handshake over the mesh, no QR ----
  {
    const A = node(), B = node(); wire(A, B);
    const linkedA = {}, linkedB = {};
    const connA = X.signal.createConnector({
      gun: A.gun, identity: alice, RTCPeerConnection: FakePC, iceServers: () => [],
      onLink: (link, peer) => { linkedA[peer] = link; A.addLink(link); },
      isConnected: (pk) => !!linkedA[pk]
    });
    const connB = X.signal.createConnector({
      gun: B.gun, identity: bob, RTCPeerConnection: FakePC, iceServers: () => [],
      onLink: (link, peer) => { linkedB[peer] = link; B.addLink(link); },
      isConnected: (pk) => !!linkedB[pk]
    });
    connA.watch(); connB.watch();

    // Alice reaches Bob purely over the existing mesh (the stub link), no scan:
    await connA.connectTo(bob.signPk, bob.boxPk);

    await waitFor(() => linkedA[bob.signPk] && linkedB[alice.signPk], 5000);
    assert(linkedA[bob.signPk], 'Alice linked to Bob via mesh signaling');
    assert(linkedB[alice.signPk], 'Bob linked to Alice via mesh signaling');
    console.log('  [2] mesh-signaled link established with no QR OK');
  }

  console.log('PHASE 5 TESTS OK');
  cleanup(); process.exit(0);
})().catch((e) => { cleanup(); console.error('TEST FAIL:', e && e.stack || e); process.exit(1); });
