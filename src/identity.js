/* Xnet — identity & crypto (TweetNaCl, pure-JS, works on every origin incl. data:).
   Identity = ed25519 signing keypair (authorship/address) + x25519 box keypair (encrypt-to).
   Rooms are sealed with NaCl secretbox under a per-room secret. DESIGN §9, §6. */
(function (root) {
  'use strict';
  var Xnet = root.Xnet = root.Xnet || {};
  var nacl = root.nacl;

  // ---- byte/string/base64 helpers ----
  function bytesToB64(bytes) {
    var bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }
  function b64ToBytes(s) {
    var bin = atob(s), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function strToBytes(s) { return new TextEncoder().encode(s); }
  function bytesToStr(b) { return new TextDecoder().decode(b); }

  function hex(bytes) { var h = ''; for (var i = 0; i < bytes.length; i++) h += ('0' + bytes[i].toString(16)).slice(-2); return h; }
  function uuid() { return hex(nacl.randomBytes(16)); }                 // 128-bit unguessable id

  // ---- identity ----
  function newIdentity() {
    var s = nacl.sign.keyPair();   // ed25519
    var b = nacl.box.keyPair();    // x25519
    return {
      signPk: bytesToB64(s.publicKey), signSk: bytesToB64(s.secretKey),
      boxPk: bytesToB64(b.publicKey), boxSk: bytesToB64(b.secretKey)
    };
  }

  // ---- signatures (authorship) ----
  function sign(msgBytes, signSkB64) { return bytesToB64(nacl.sign.detached(msgBytes, b64ToBytes(signSkB64))); }
  function verify(msgBytes, sigB64, signPkB64) {
    try { return nacl.sign.detached.verify(msgBytes, b64ToBytes(sigB64), b64ToBytes(signPkB64)); }
    catch (e) { return false; }
  }

  // ---- per-room symmetric encryption (secretbox) ----
  function newRoomSecret() { return bytesToB64(nacl.randomBytes(nacl.secretbox.keyLength)); }
  function seal(plainStr, secretB64) {
    var nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    var box = nacl.secretbox(strToBytes(plainStr), nonce, b64ToBytes(secretB64));
    return bytesToB64(nonce) + ':' + bytesToB64(box);
  }
  function open(cipher, secretB64) {
    var p = String(cipher).split(':'); if (p.length !== 2) return null;
    var out = nacl.secretbox.open(b64ToBytes(p[1]), b64ToBytes(p[0]), b64ToBytes(secretB64));
    return out ? bytesToStr(out) : null;
  }

  // ---- encrypt-to-recipient (box) — used by signaling in a later phase ----
  function boxSeal(plainStr, recipBoxPkB64, myBoxSkB64) {
    var nonce = nacl.randomBytes(nacl.box.nonceLength);
    var c = nacl.box(strToBytes(plainStr), nonce, b64ToBytes(recipBoxPkB64), b64ToBytes(myBoxSkB64));
    return bytesToB64(nonce) + ':' + bytesToB64(c);
  }
  function boxOpen(cipher, senderBoxPkB64, myBoxSkB64) {
    var p = String(cipher).split(':'); if (p.length !== 2) return null;
    var out = nacl.box.open(b64ToBytes(p[1]), b64ToBytes(p[0]), b64ToBytes(senderBoxPkB64), b64ToBytes(myBoxSkB64));
    return out ? bytesToStr(out) : null;
  }

  Xnet.crypto = {
    enc: { bytesToB64: bytesToB64, b64ToBytes: b64ToBytes, strToBytes: strToBytes, bytesToStr: bytesToStr, hex: hex },
    uuid: uuid, newIdentity: newIdentity, sign: sign, verify: verify,
    newRoomSecret: newRoomSecret, seal: seal, open: open, boxSeal: boxSeal, boxOpen: boxOpen
  };
})(typeof window !== 'undefined' ? window : globalThis);
