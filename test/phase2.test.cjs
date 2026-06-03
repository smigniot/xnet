/* Node logic tests for Phase 2 (crypto + store[memory] + model + eviction).
   The IndexedDB path runs only in a browser; here we exercise the in-memory backend,
   which shares the model's code path. Run: `node test/phase2.test.cjs`. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---- minimal browser-ish globals TweetNaCl + modules expect ----
globalThis.self = globalThis;
const { webcrypto } = require('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const SRC = path.join(__dirname, '..', 'src');

// Load TweetNaCl (UMD) into a shim and publish as global `nacl`.
const naclCode = fs.readFileSync(path.join(SRC, 'vendor', 'nacl.min.js'), 'utf8');
const shim = { exports: {} };
new Function('module', 'exports', 'self', 'window', naclCode)(shim, shim.exports, globalThis, undefined);
globalThis.nacl = shim.exports && shim.exports.randomBytes ? shim.exports : globalThis.nacl;
assert(globalThis.nacl && globalThis.nacl.randomBytes, 'nacl loaded with PRNG');

// Load our modules (they attach to globalThis.Xnet); indirect eval = global scope.
const load = (f) => (0, eval)(fs.readFileSync(path.join(SRC, f), 'utf8'));
load('identity.js'); load('store.js'); load('model.js');
const X = globalThis.Xnet;

(async () => {
  // ---------- crypto ----------
  const id = X.crypto.newIdentity();
  assert(id.signPk && id.signSk && id.boxPk && id.boxSk, 'identity has all keys');

  const sec = X.crypto.newRoomSecret();
  const c = X.crypto.seal('hello world', sec);
  assert.strictEqual(X.crypto.open(c, sec), 'hello world', 'secretbox roundtrip');
  assert.strictEqual(X.crypto.open(c, X.crypto.newRoomSecret()), null, 'wrong key → null');

  const m = X.crypto.enc.strToBytes('payload');
  const sig = X.crypto.sign(m, id.signSk);
  assert(X.crypto.verify(m, sig, id.signPk), 'sign/verify ok');
  assert(!X.crypto.verify(X.crypto.enc.strToBytes('tampered'), sig, id.signPk), 'verify rejects tamper');

  const a = X.crypto.newIdentity(), b = X.crypto.newIdentity();
  const bc = X.crypto.boxSeal('to-bob', b.boxPk, a.boxSk);
  assert.strictEqual(X.crypto.boxOpen(bc, a.boxPk, b.boxSk), 'to-bob', 'box (encrypt-to) roundtrip');
  assert.strictEqual(X.crypto.boxOpen(bc, X.crypto.newIdentity().boxPk, b.boxSk), null, 'box wrong sender → null');

  assert.notStrictEqual(X.crypto.uuid(), X.crypto.uuid(), 'uuids differ');
  assert.match(X.crypto.uuid(), /^[0-9a-f]{32}$/, 'uuid is 128-bit hex');

  // ---------- model on the in-memory store ----------
  const store = X.store._memBackend();
  const info = await X.model.init(store);
  assert.strictEqual(info.mode, 'ephemeral', 'memory store is ephemeral');
  assert(info.identity.displayName.startsWith('anon-'), 'default display name');

  const room = await X.model.createRoom('general');
  await X.model.sendMessage(room.id, 'first');
  await X.model.sendMessage(room.id, 'second');

  let msgs = await X.model.getMessages(room.id);
  assert.strictEqual(msgs.length, 2, 'two messages');
  assert.strictEqual(msgs[0].text, 'first', 'decrypts in order');
  assert(msgs[0].mine && msgs[0].verified, 'own message verified');

  // messages are stored as ciphertext, not plaintext
  const raw = (await store.messagesByRoom(room.id))[0];
  assert(!JSON.stringify(raw).includes('first'), 'message stored encrypted at rest');

  assert.strictEqual(await X.model.unreadCount(room.id), 2, 'unread = 2 before read');
  await X.model.markRead(room.id);
  assert.strictEqual(await X.model.unreadCount(room.id), 0, 'unread = 0 after read');

  await X.model.renameRoom(room.id, 'lobby');
  let jr = await X.model.joinedRooms();
  assert.strictEqual(jr[0].room.name, 'lobby', 'rename applied');

  await X.model.unjoinRoom(room.id);
  jr = await X.model.joinedRooms();
  assert.strictEqual(jr.length, 0, 'unjoin hides room');
  assert.strictEqual((await store.messagesByRoom(room.id)).length, 2, 'messages retained after unjoin (never deleted)');

  // ---------- eviction (storage-pressure, sticky horizon) ----------
  await testEviction();

  console.log('PHASE 2 TESTS OK');
})().catch((e) => { console.error('TEST FAIL:', e && e.stack || e); process.exit(1); });

async function testEviction() {
  const mem = X.store._memBackend();
  const quota = 1000;
  // simulate ~2 bytes/message of pressure so watermarks (70%→50%) map to counts (350→250)
  mem.estimate = async () => ({ usage: (await mem.count('messages')) * 2, quota });

  await X.model.init(mem);
  const r = await X.model.createRoom('big');
  let t = 1;
  // deterministic increasing timestamps so oldest-first is well-defined
  const realNow = Date.now;
  Date.now = () => 1000000 + (t++); // monotonic
  for (let i = 0; i < 600; i++) await X.model.sendMessage(r.id, 'm' + i);
  Date.now = realNow;

  const before = (await mem.messagesByRoom(r.id)).length;
  assert.strictEqual(before, 600, '600 messages created');

  const ev = await X.model.evictIfNeeded();
  const after = (await mem.messagesByRoom(r.id)).length;
  assert(ev.evicted > 0, 'eviction ran under pressure');
  assert(after > 0 && after <= 250, 'evicted down to ≤ low-watermark count, after=' + after);

  const mb = await mem.get('membership', r.id);
  assert(mb.evictHorizonTs > 0, 'sticky horizon advanced');

  // remaining messages are all newer than the horizon; nothing below it survives the filter
  const shown = await X.model.getMessages(r.id);
  assert.strictEqual(shown.length, after, 'getMessages == retained (horizon filter consistent)');
  assert(shown.every((mm) => mm.ts >= mb.evictHorizonTs), 'no shown message older than horizon');

  console.log('  eviction: before=%d after=%d evicted=%d horizon=%d', before, after, ev.evicted, mb.evictHorizonTs);
}
