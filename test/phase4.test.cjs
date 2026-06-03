/* Node tests for Phase 4 pure core: invite pack/unpack + the QR encode->raster->jsQR decode
   roundtrip (proves both QR libs interoperate without a browser). WebRTC itself is browser-only
   and verified by a real two-device pairing. Run: `node test/phase4.test.cjs`. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

globalThis.self = globalThis;
const { webcrypto } = require('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const SRC = path.join(__dirname, '..', 'src');
function loadUMD(file, pick) {
  const code = fs.readFileSync(path.join(SRC, 'vendor', file), 'utf8');
  const shim = { exports: {} };
  new Function('module', 'exports', 'self', 'window', code)(shim, shim.exports, globalThis, undefined);
  return pick(shim.exports);
}
globalThis.nacl = loadUMD('nacl.min.js', (e) => e.randomBytes ? e : globalThis.nacl);
globalThis.qrcode = loadUMD('qrcode.js', (e) => (typeof e === 'function' ? e : globalThis.qrcode));
globalThis.jsQR = loadUMD('jsQR.js', (e) => e.default || e);

const load = (f) => (0, eval)(fs.readFileSync(path.join(SRC, f), 'utf8'));
load('identity.js'); load('codec.js'); load('qr.js'); load('signaling.js');
const X = globalThis.Xnet;

// Node codec impl (zlib 'deflate' matches browser CompressionStream('deflate')).
X.codec.setImpl({
  deflate: async (b) => new Uint8Array(zlib.deflateSync(Buffer.from(b))),
  inflate: async (b) => new Uint8Array(zlib.inflateSync(Buffer.from(b)))
});

// A realistic data-channel offer SDP with host + srflx candidates.
const SAMPLE_SDP = [
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  'a=candidate:1 1 udp 2122260223 192.168.1.34 51580 typ host generation 0',
  'a=candidate:2 1 udp 1686052607 203.0.113.7 51580 typ srflx raddr 192.168.1.34 rport 51580 generation 0',
  'a=ice-ufrag:Xa1b', 'a=ice-pwd:abcdefghijklmnopqrstuvwx', 'a=ice-options:trickle',
  'a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89',
  'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144'
].join('\r\n') + '\r\n';

(async () => {
  const id = X.crypto.newIdentity();
  const room = { id: X.crypto.uuid(), secret: X.crypto.newRoomSecret(), name: 'general' };

  // ---- 1) offer/answer invite roundtrip ----
  {
    const offerB64 = await X.signaling.packOffer(SAMPLE_SDP, id, room);
    const o = await X.signaling.unpack(offerB64);
    assert.strictEqual(o.type, 'offer');
    assert.strictEqual(o.sdp, SAMPLE_SDP, 'SDP survives roundtrip');
    assert.strictEqual(o.pub.signPk, id.signPk, 'signing pubkey carried');
    assert.strictEqual(o.pub.boxPk, id.boxPk, 'box pubkey carried');
    assert.deepStrictEqual(o.room, room, 'room descriptor carried');

    const answerB64 = await X.signaling.packAnswer(SAMPLE_SDP, id);
    const a = await X.signaling.unpack(answerB64);
    assert.strictEqual(a.type, 'answer');
    assert(!a.room, 'answer carries no room');
    console.log('  [1] invite pack/unpack roundtrip OK (offer b64 len=%d)', offerB64.length);
  }

  // ---- 2) QR encode -> rasterize -> jsQR decode, on a real-sized invite ----
  {
    const offerB64 = await X.signaling.packOffer(SAMPLE_SDP, id, room);
    const m = X.qr.model(offerB64, 'L');
    const img = X.qr.rasterize(offerB64, { cell: 4, margin: 4 });
    const decoded = X.qr.decode(img);
    assert.strictEqual(decoded, offerB64, 'QR encode->decode preserves the invite');
    console.log('  [2] QR roundtrip OK (version=%d, %dx%d px)', m.getModuleCount(), img.width, img.height);
  }

  // ---- 3) ICE config: defaults, LAN-only, and opt-in TURN ----
  {
    assert(X.signaling.iceServers({}).length >= 4, 'default STUN list present');
    assert.strictEqual(X.signaling.iceServers({ lanOnly: true }).length, 0, 'LAN-only = no servers');
    const withTurn = X.signaling.iceServers({ turn: { url: 'turn:my.relay:3478', username: 'u', credential: 'p' } });
    assert(withTurn.some((s) => /^turn:/.test(s.urls)), 'TURN appended when provided');
    console.log('  [3] ICE config OK');
  }

  console.log('PHASE 4 CORE TESTS OK');
  process.exit(0);
})().catch((e) => { console.error('TEST FAIL:', e && e.stack || e); process.exit(1); });
