/* Xnet — encrypted room sync over the gun graph (DESIGN §6.1, §9).
   Shared data lives in gun under `xnet/rooms/<id>`: meta, members (pubkeys), messages.
   Message CONTENT is sealed with the room secret (NaCl secretbox) and signed before it ever
   enters the graph, so relaying non-members carry ciphertext only. Routing metadata
   (roomId, authorPub, ts) stays clear so gun can sync. */
(function (root) {
  'use strict';
  var Xnet = root.Xnet = root.Xnet || {};
  var NS = 'xnet';
  var C = function () { return Xnet.crypto; };

  function roomNode(gun, roomId) { return gun.get(NS).get('rooms').get(roomId); }
  function canon(roomId, ts, cipher) { return C().enc.strToBytes(roomId + '|' + ts + '|' + cipher); }

  // ---- room metadata ----
  function putRoomMeta(gun, room) {
    roomNode(gun, room.id).get('meta').put({ id: room.id, name: room.name, createdAt: room.createdAt, createdBy: room.createdBy });
  }
  function onRoomMeta(gun, roomId, cb) {
    roomNode(gun, roomId).get('meta').on(function (m) {
      if (m) cb({ id: m.id, name: m.name, createdAt: m.createdAt, createdBy: m.createdBy });
    });
  }

  // ---- members (pubkeys; lets any member address/sign to any other later) ----
  function addMember(gun, roomId, member) {
    roomNode(gun, roomId).get('members').get(member.signPk).put({ signPk: member.signPk, boxPk: member.boxPk, name: member.name });
  }
  function onMembers(gun, roomId, cb) {
    roomNode(gun, roomId).get('members').map().on(function (m, key) { if (m && m.signPk) cb(m, key); });
  }

  // ---- messages ----
  function publishMessage(gun, roomId, secret, identity, text) {
    var ts = Date.now();
    var cipher = C().seal(String(text), secret);
    var sig = C().sign(canon(roomId, ts, cipher), identity.signSk);
    var id = C().uuid();
    var msg = { id: id, authorPub: identity.signPk, ts: ts, cipher: cipher, sig: sig };
    roomNode(gun, roomId).get('messages').get(id).put(msg);   // deterministic key = id (aids dedup)
    return msg;
  }
  // cb({id, authorPub, ts, text|null, verified}). opts.horizon() -> ts below which to drop (eviction §7.2).
  function onMessage(gun, roomId, secret, opts, cb) {
    opts = opts || {};
    roomNode(gun, roomId).get('messages').map().on(function (m, key) {
      if (!m || !m.id || !m.cipher) return;
      var horizon = opts.horizon ? opts.horizon() : 0;
      if (m.ts < horizon) return;
      var verified = C().verify(canon(roomId, m.ts, m.cipher), m.sig, m.authorPub);
      var text = secret ? C().open(m.cipher, secret) : null;
      cb({ id: m.id, authorPub: m.authorPub, ts: m.ts, text: text, verified: verified, key: key });
    });
  }

  Xnet.sync = {
    putRoomMeta: putRoomMeta, onRoomMeta: onRoomMeta,
    addMember: addMember, onMembers: onMembers,
    publishMessage: publishMessage, onMessage: onMessage
  };
})(typeof window !== 'undefined' ? window : globalThis);
