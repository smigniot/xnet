/* Xnet — compact codec for QR invites: JSON -> deflate -> base64url (and back).
   Browser uses CompressionStream('deflate'); Node tests inject a zlib impl via setImpl().
   DESIGN §2.2 (keep the QR payload small). */
(function (root) {
  'use strict';
  var Xnet = root.Xnet = root.Xnet || {};

  function bytesToB64url(bytes) {
    var bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlToBytes(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    var bin = atob(str), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }

  var impl = null;                 // optional { deflate(bytes)->Promise<bytes>, inflate(bytes)->Promise<bytes> }
  function setImpl(i) { impl = i; }

  async function deflate(bytes) {
    if (impl) return impl.deflate(bytes);
    var s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function inflate(bytes) {
    if (impl) return impl.inflate(bytes);
    var s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  async function pack(obj) {
    return bytesToB64url(await deflate(new TextEncoder().encode(JSON.stringify(obj))));
  }
  async function unpack(str) {
    return JSON.parse(new TextDecoder().decode(await inflate(b64urlToBytes(str))));
  }

  Xnet.codec = { bytesToB64url: bytesToB64url, b64urlToBytes: b64urlToBytes, deflate: deflate, inflate: inflate, pack: pack, unpack: unpack, setImpl: setImpl };
})(typeof window !== 'undefined' ? window : globalThis);
