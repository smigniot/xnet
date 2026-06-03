/* Xnet — live networking runtime: the single gun mesh + room messaging over it.
   Messages flow through gun (sync.js, encrypted); paired RTCDataChannels are plugged in as
   mesh links. Keeps an in-memory per-room cache so the UI can render + count unread reactively.
   Local-only data (identity, secrets, membership) still comes from the store via model.js. */
(function (root) {
  'use strict';
  var Xnet = root.Xnet = root.Xnet || {};

  var mesh = null, gun = null, onChange = null;
  var cache = {};   // roomId -> { msgs: Map(id->msg), subbed: bool }

  function start(Gun) { if (!mesh) { mesh = Xnet.mesh.create(Gun); gun = mesh.gun; } return mesh; }
  function setOnChange(fn) { onChange = fn; }
  function fire(roomId) { if (onChange) try { onChange(roomId); } catch (e) {} }
  function rc(roomId) { return cache[roomId] || (cache[roomId] = { msgs: new Map(), subbed: false }); }

  // Subscribe a room's encrypted message stream into the cache (idempotent).
  function ensureRoom(roomId, secret, horizonFn) {
    var c = rc(roomId);
    if (c.subbed) return;
    c.subbed = true;
    Xnet.sync.onMessage(gun, roomId, secret, { horizon: horizonFn }, function (m) {
      var had = c.msgs.has(m.id);
      c.msgs.set(m.id, m);
      if (!had) fire(roomId);
    });
  }
  function publishMeta(room) { Xnet.sync.putRoomMeta(gun, room); }
  function addMember(roomId, member) { Xnet.sync.addMember(gun, roomId, member); }
  function onMembers(roomId, cb) { Xnet.sync.onMembers(gun, roomId, cb); }
  function send(roomId, secret, identity, text) { return Xnet.sync.publishMessage(gun, roomId, secret, identity, text); }

  function messages(roomId, horizon) {
    var c = cache[roomId]; if (!c) return [];
    return Array.from(c.msgs.values())
      .filter(function (m) { return m.ts >= (horizon || 0); })
      .sort(function (a, b) { return a.ts - b.ts; });
  }
  function unread(roomId, lastReadTs, horizon) {
    var c = cache[roomId]; if (!c) return 0; var n = 0;
    c.msgs.forEach(function (m) { if (m.ts > (horizon || 0) && m.ts > (lastReadTs || 0)) n++; });
    return n;
  }

  function addLink(link) { return mesh.addLink(link); }
  function peerCount() { return mesh ? mesh.peerCount() : 0; }

  Xnet.net = {
    start: start, setOnChange: setOnChange,
    ensureRoom: ensureRoom, publishMeta: publishMeta, addMember: addMember, onMembers: onMembers,
    send: send, messages: messages, unread: unread,
    addLink: addLink, peerCount: peerCount, gun: function () { return gun; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
