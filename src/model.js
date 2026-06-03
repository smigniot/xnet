/* Xnet — local data model (rooms, messages, unread, eviction). DOM-free and testable.
   Single-peer in Phase 2: sending stores locally; the gun mesh arrives in a later phase.
   DESIGN §6 (model), §7.2 (storage-pressure eviction). */
(function (root) {
  'use strict';
  var Xnet = root.Xnet = root.Xnet || {};
  var store = null, identity = null, settings = null;
  var now = function () { return Date.now(); };
  var C = function () { return Xnet.crypto; };

  async function init(s) {
    store = s;
    identity = await loadIdentity();
    settings = await loadSettings();
    return { mode: store.mode, identity: identity, settings: settings };
  }

  async function loadIdentity() {
    var rec = await store.get('kv', 'identity');
    if (rec && rec.v) return rec.v;
    var id = C().newIdentity();
    id.displayName = 'anon-' + id.signPk.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toLowerCase();
    await store.put('kv', { k: 'identity', v: id });
    return id;
  }
  async function setDisplayName(name) {
    name = (name || '').trim(); if (!name) return identity;
    identity.displayName = name;
    await store.put('kv', { k: 'identity', v: identity });
    return identity;
  }
  async function loadSettings() {
    var rec = await store.get('kv', 'settings');
    var def = { highMark: 0.70, lowMark: 0.50, lanOnly: false, stun: [], turn: null };
    if (rec && rec.v) return Object.assign(def, rec.v);
    await store.put('kv', { k: 'settings', v: def });
    return def;
  }
  async function updateSettings(patch) {
    settings = Object.assign(settings || {}, patch || {});
    await store.put('kv', { k: 'settings', v: settings });
    return settings;
  }

  // ---- rooms ----
  async function createRoom(name) {
    var id = C().uuid();
    var room = { id: id, name: (name || 'untitled').trim() || 'untitled', createdAt: now(), createdBy: identity.signPk };
    await store.put('rooms', room);
    await store.put('roomSecrets', { roomId: id, secret: C().newRoomSecret() });
    await store.put('membership', { roomId: id, joined: true, lastReadTs: 0, evictHorizonTs: 0 });
    return room;
  }
  async function renameRoom(id, name) {
    var r = await store.get('rooms', id); if (!r) return null;
    r.name = (name || '').trim() || r.name; await store.put('rooms', r); return r;
  }
  async function unjoinRoom(id) {
    var mb = await store.get('membership', id); if (!mb) return;
    mb.joined = false; await store.put('membership', mb);   // never deletes room/messages — DESIGN §6.3
  }
  async function joinedRooms() {
    var rooms = await store.all('rooms'), out = [];
    for (var i = 0; i < rooms.length; i++) {
      var mb = await store.get('membership', rooms[i].id);
      if (mb && mb.joined) out.push({ room: rooms[i], membership: mb, unread: await unreadCount(rooms[i].id, mb) });
    }
    out.sort(function (a, b) { return b.room.createdAt - a.room.createdAt; });
    return out;
  }
  async function secretFor(roomId) { var rec = await store.get('roomSecrets', roomId); return rec && rec.secret; }

  // ---- messages ----
  async function unreadCount(roomId, mb) {
    mb = mb || await store.get('membership', roomId); if (!mb) return 0;
    var msgs = await store.messagesByRoom(roomId), n = 0;
    for (var i = 0; i < msgs.length; i++) { var m = msgs[i]; if (m.ts > mb.evictHorizonTs && m.ts > mb.lastReadTs) n++; }
    return n;
  }
  async function getMessages(roomId) {
    var mb = await store.get('membership', roomId), horizon = mb ? mb.evictHorizonTs : 0;
    var secret = await secretFor(roomId), msgs = await store.messagesByRoom(roomId), out = [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i]; if (m.ts < horizon) continue;              // sticky horizon filter
      var ok = m.sig ? C().verify(C().enc.strToBytes(roomId + '|' + m.ts + '|' + m.cipher), m.sig, m.authorPub) : true;
      var text = secret ? C().open(m.cipher, secret) : null;
      out.push({
        id: m.id, roomId: roomId, authorPub: m.authorPub, ts: m.ts,
        text: text === null ? '⁉ [unable to decrypt]' : text,
        mine: m.authorPub === identity.signPk, verified: ok
      });
    }
    return out;
  }
  async function sendMessage(roomId, text) {
    var secret = await secretFor(roomId); if (!secret) throw new Error('no room secret');
    var ts = now(), cipher = C().seal(String(text), secret);
    var sig = C().sign(C().enc.strToBytes(roomId + '|' + ts + '|' + cipher), identity.signSk);
    var msg = { id: C().uuid(), roomId: roomId, authorPub: identity.signPk, ts: ts, cipher: cipher, sig: sig };
    await store.put('messages', msg);
    return { id: msg.id, roomId: roomId, authorPub: msg.authorPub, ts: ts, text: String(text), mine: true, verified: true };
  }
  async function markRead(roomId) {
    var mb = await store.get('membership', roomId); if (!mb) return;
    var msgs = await store.messagesByRoom(roomId);
    var last = msgs.length ? msgs[msgs.length - 1].ts : 0;
    mb.lastReadTs = Math.max(mb.lastReadTs, last, now());
    await store.put('membership', mb);
  }

  // ---- storage-pressure eviction (local-only, sticky horizon) — DESIGN §7.2 ----
  async function evictIfNeeded() {
    var est = await store.estimate();
    if (!est || !est.quota) return { evicted: 0, reason: 'no-estimate' };
    var high = settings.highMark * est.quota, low = settings.lowMark * est.quota;
    if (est.usage < high) return { evicted: 0, reason: 'below-high' };
    var evicted = 0, guard = 0, horizons = {};
    while (est && est.usage > low && guard++ < 1000) {
      var batch = await store.messagesOldest(200);
      if (!batch.length) break;
      for (var i = 0; i < batch.length; i++) {
        var m = batch[i]; await store.del('messages', m.id); evicted++;
        horizons[m.roomId] = Math.max(horizons[m.roomId] || 0, m.ts);
      }
      est = await store.estimate();
    }
    var ids = Object.keys(horizons);
    for (var j = 0; j < ids.length; j++) {
      var mb = await store.get('membership', ids[j]);
      if (mb) { mb.evictHorizonTs = Math.max(mb.evictHorizonTs, horizons[ids[j]]); await store.put('membership', mb); }
    }
    return { evicted: evicted, reason: 'pressure' };
  }

  // ---- pairing helpers (Phase 4) ----
  function selfMember() { return { signPk: identity.signPk, boxPk: identity.boxPk, name: identity.displayName }; }

  // Bob joins a room he was invited into (id/secret/name from the QR offer). Idempotent.
  async function joinFromInvite(room) {
    var existing = await store.get('rooms', room.id);
    if (!existing) {
      await store.put('rooms', { id: room.id, name: (room.name || 'shared room'), createdAt: now(), createdBy: null });
      await store.put('roomSecrets', { roomId: room.id, secret: room.secret });
    }
    var mb = await store.get('membership', room.id);
    if (!mb) await store.put('membership', { roomId: room.id, joined: true, lastReadTs: 0, evictHorizonTs: 0 });
    else if (!mb.joined) { mb.joined = true; await store.put('membership', mb); }
    return store.get('rooms', room.id);
  }

  async function addContact(pub) {
    if (!pub || !pub.signPk) return;
    var prev = await store.get('contacts', pub.signPk);
    await store.put('contacts', { pub: pub.signPk, boxPk: pub.boxPk, name: pub.name || (prev && prev.name) || ('peer-' + String(pub.signPk).replace(/[^a-zA-Z0-9]/g, '').slice(0, 4)) });
  }
  function getContacts() { return store.all('contacts'); }

  // {room, membership, secret} bundle for the net layer.
  async function roomBundle(roomId) {
    return { room: await store.get('rooms', roomId), membership: await store.get('membership', roomId), secret: await secretFor(roomId) };
  }

  Xnet.model = {
    init: init,
    getIdentity: function () { return identity; },
    getSettings: function () { return settings; },
    updateSettings: updateSettings,
    setDisplayName: setDisplayName,
    createRoom: createRoom, renameRoom: renameRoom, unjoinRoom: unjoinRoom, joinedRooms: joinedRooms,
    getMessages: getMessages, sendMessage: sendMessage, markRead: markRead, unreadCount: unreadCount,
    evictIfNeeded: evictIfNeeded,
    selfMember: selfMember, joinFromInvite: joinFromInvite, addContact: addContact, getContacts: getContacts,
    roomBundle: roomBundle, secretFor: secretFor
  };
})(typeof window !== 'undefined' ? window : globalThis);
