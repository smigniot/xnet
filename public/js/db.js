// db.js
// -----
// Identity, the public username directory, contacts, one-on-one messages,
// shared rooms, invitations and unread state.
//
// Storage architecture (see store.js): Gun is a MEMORY-ONLY transport here
// (radisk:false, localStorage:false). Everything durable — the session key,
// contacts, room keys, read marks, eviction horizons and message ciphertext —
// lives in our own IndexedDB store, which we can prune locally without ever
// emitting a graph-level delete. That separation is what lets a client run
// "forever": it keeps as much as the device allows and sheds only the oldest
// data, locally, under real storage pressure.
//
// Privacy: message bodies are encrypted before they touch Gun AND before they
// touch IndexedDB (we store ciphertext at rest, decrypting on read). Known
// metadata leaks are unchanged: the username directory (alias->pub), the inbox
// (who contacted whom) and outer timestamps.

import {
  conversationId, newRoomKey, sealDM, openDM, sealRoom, openRoom,
  sealToSelf, openFromSelf, signClaim,
} from './crypto.js';
import * as store from './store.js';

const Gun = window.Gun;

// Deterministic, time-ordered message key: zero-padded ts + random suffix.
// Lexicographic order ~ chronological order, so the server can range-scan and
// prune by age (and clients dedupe) without decrypting anything.
let keySeq = 0;
function makeMsgKey(ts) {
  const rnd = Math.floor(Math.random() * 1e6).toString(36) + (keySeq++).toString(36);
  return `${String(ts).padStart(15, '0')}-${rnd}`;
}

const peers = [location.origin.replace(/\/$/, '') + '/gun'];
// Memory-only: Gun syncs over the network but persists nothing locally.
// Durability is ours (store.js).
export const gun = Gun({ peers, radisk: false, localStorage: false });
const root = gun.get('xnet');
export const user = gun.user();

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------
const listeners = {};
export function on(evt, cb) {
  (listeners[evt] = listeners[evt] || new Set()).add(cb);
  return () => listeners[evt].delete(cb);
}
function emit(evt, data) {
  (listeners[evt] || []).forEach((cb) => {
    try { cb(data); } catch (e) { console.error(e); }
  });
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
export const session = {
  pub: null, epub: null, alias: null, displayName: null, pair: null,
};

function loadSessionFromUser() {
  session.pub = user.is.pub;
  session.epub = user.is.epub;
  session.alias = user.is.alias;
  session.pair = user._.sea;
}

export function isLoggedIn() {
  return !!(user.is && user.is.pub);
}

// Per-user IndexedDB key namespacing, so two identities on one device stay
// isolated.
const ukey = (k) => `${k}:${session.pub}`;
// Message scope strings carry the owner pub so eviction/horizons are per-user.
const dmScope = (convId) => `${session.pub}|dm:${convId}`;
const roomScope = (roomId) => `${session.pub}|room:${roomId}`;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// Restore a previous session from our own store (works offline: auth-by-pair
// is local crypto, no network needed).
export async function recall() {
  const pair = await store.kvGet('pair').catch(() => null);
  if (!pair) return false;
  try {
    await loginWithPair(pair);
    return true;
  } catch {
    return false;
  }
}

export function signup(alias, displayName, pass) {
  alias = alias.trim().toLowerCase();
  return new Promise((resolve, reject) => {
    if (!/^[a-z0-9_]{3,20}$/.test(alias)) {
      return reject(new Error('Username must be 3-20 chars: a-z, 0-9, underscore.'));
    }
    root.get('directory').get(alias).once((existing) => {
      if (existing && existing.pub) return reject(new Error('That username is taken.'));
      user.create(alias, pass, (ack) => {
        if (ack.err) return reject(new Error(ack.err));
        user.auth(alias, pass, async (ack2) => {
          if (ack2.err) return reject(new Error(ack2.err));
          loadSessionFromUser();
          session.displayName = displayName || alias;
          await store.kvSet('pair', session.pair);
          await publishDirectory(displayName || alias);
          await afterAuth();
          resolve(session);
        });
      });
    });
  });
}

export function login(alias, pass) {
  alias = alias.trim().toLowerCase();
  return new Promise((resolve, reject) => {
    user.auth(alias, pass, async (ack) => {
      if (ack.err) return reject(new Error(ack.err));
      loadSessionFromUser();
      await store.kvSet('pair', session.pair);
      await afterAuth();
      resolve(session);
    });
  });
}

export function loginWithPair(pair) {
  return new Promise((resolve, reject) => {
    user.auth(pair, async (ack) => {
      if (ack.err) return reject(new Error(ack.err));
      loadSessionFromUser();
      await store.kvSet('pair', session.pair);
      await afterAuth();
      resolve(session);
    });
  });
}

export function logout() {
  user.leave();
  store.kvDel('pair').catch(() => {});
  session.pub = session.epub = session.alias = session.displayName = session.pair = null;
  emit('auth', null);
}

export function exportPair() {
  return JSON.stringify(user._.sea, null, 2);
}

async function publishDirectory(displayName) {
  const entry = {
    alias: session.alias,
    displayName: displayName || session.displayName || session.alias,
    pub: session.pub,
    epub: session.epub,
  };
  root.get('directory').get(session.alias).put(entry);
  user.get('profile').put({ displayName: entry.displayName });
}

async function afterAuth() {
  store.persist(); // ask the browser to keep our data durable

  // 1) Load durable state from our own store FIRST (offline-capable boot).
  horizons = new Map(Object.entries((await store.kvGet(ukey('horizons'))) || {}));
  const savedReads = (await store.kvGet(ukey('reads'))) || {};
  for (const [id, ts] of Object.entries(savedReads)) lastRead.set(id, ts);

  for (const c of (await store.kvGet(ukey('contacts'))) || []) {
    contacts.set(c.convId, c);
    subscribeDM(c);
  }
  for (const r of (await store.kvGet(ukey('rooms'))) || []) {
    rooms.set(r.roomId, r);
    subscribeRoom(r);
  }

  // Username: on pair-based recall, Gun's user.is.alias degrades to the pubkey,
  // so restore the real alias we saved at signup/login (keyed by our pub).
  const savedAlias = await store.kvGet(ukey('alias'));
  if (savedAlias) session.alias = savedAlias;
  else if (session.alias && session.alias !== session.pub) store.kvSet(ukey('alias'), session.alias);

  // Display name: keep one set this session (signup), else from store, else alias.
  // Then refine from the synced profile if/when it arrives.
  session.displayName = session.displayName || (await store.kvGet(ukey('displayName'))) || session.alias;
  store.kvSet(ukey('displayName'), session.displayName);
  user.get('profile').once((p) => {
    if (p && p.displayName) {
      session.displayName = p.displayName;
      store.kvSet(ukey('displayName'), p.displayName);
    }
  });

  emit('auth', session);
  emit('contacts', [...contacts.values()]);
  emit('rooms', [...rooms.values()]);

  // 2) Start Gun sync (relay/peers) to pick up anything new / cross-device.
  subscribeContacts();
  subscribeRooms();
  subscribeInbox();
  startEvictionTimer();
}

// ---------------------------------------------------------------------------
// Inbox (how a recipient discovers a conversation a stranger started)
// ---------------------------------------------------------------------------
function announceTo(theirPub) {
  root.get('inbox').get(theirPub).get(session.pub).put({
    alias: session.alias,
    displayName: session.displayName,
    pub: session.pub,
    epub: session.epub,
  });
}

function subscribeInbox() {
  root.get('inbox').get(session.pub).map().on(async (card) => {
    if (!card || !card.pub || card.pub === session.pub) return;
    const convId = await conversationId(session.pub, card.pub);
    if (contacts.has(convId)) return;
    await addContact({ alias: card.alias, displayName: card.displayName, pub: card.pub, epub: card.epub }, true);
  });
}

// ---------------------------------------------------------------------------
// Directory lookup
// ---------------------------------------------------------------------------
export function lookup(alias) {
  alias = alias.trim().toLowerCase();
  return new Promise((resolve) => {
    root.get('directory').get(alias).once((entry) => {
      if (entry && entry.pub && entry.epub) {
        resolve({ alias: entry.alias, displayName: entry.displayName, pub: entry.pub, epub: entry.epub });
      } else resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
export const contacts = new Map(); // convId -> {alias, displayName, pub, epub, convId}

function persistContacts() {
  store.kvSet(ukey('contacts'), [...contacts.values()]).catch(() => {});
}

export async function addContact(person, fromInbox = false) {
  const convId = await conversationId(session.pub, person.pub);
  const record = { ...person, convId };
  contacts.set(convId, record);
  persistContacts();
  if (!fromInbox) announceTo(person.pub);
  emit('contacts', [...contacts.values()]);
  subscribeDM(record);
  return record;
}

function subscribeContacts() {
  // Cross-device: contacts we added on another device live in our Gun user
  // space. We mirror any we don't already have into the local store.
  user.get('contacts').map().on(async (node, convId) => {
    if (!node || !node.blob || contacts.has(convId)) return;
    const rec = await openFromSelf(node.blob, session.pair);
    if (rec && rec.pub) {
      contacts.set(convId, rec);
      persistContacts();
      emit('contacts', [...contacts.values()]);
      subscribeDM(rec);
    }
  });
}

export async function getOrAddContact(person) {
  const convId = await conversationId(session.pub, person.pub);
  if (contacts.has(convId)) return contacts.get(convId);
  // Also record it in Gun user space for cross-device sync.
  const record = await addContact(person);
  const sealed = await sealToSelf(record, session.pair);
  user.get('contacts').get(convId).put({ blob: sealed });
  return record;
}

// ---------------------------------------------------------------------------
// One-on-one messages
// ---------------------------------------------------------------------------
const dmStore = new Map();      // convId -> Map(soul -> message)
const dmSubscribed = new Set();

export function dmMessages(convId) {
  return [...(dmStore.get(convId)?.values() || [])].sort((a, b) => a.ts - b.ts);
}

async function subscribeDM(contact) {
  if (dmSubscribed.has(contact.convId)) return;
  dmSubscribed.add(contact.convId);
  if (!dmStore.has(contact.convId)) dmStore.set(contact.convId, new Map());

  // Live + replayed-from-relay messages.
  root.get('dm').get(contact.convId).get('messages').map().on((node, soul) => {
    ingestDM(contact, node, soul);
  });
  // Durable history from our own store (offline-capable).
  await hydrateDM(contact);
}

async function hydrateDM(contact) {
  const scope = dmScope(contact.convId);
  const horizon = horizons.get(scope) || 0;
  const rows = await store.messagesForScope(scope);
  const mem = dmStore.get(contact.convId);
  let added = false;
  for (const r of rows) {
    if (mem.has(r.id) || r.ts <= horizon) continue;
    const payload = await openDM(r.ct, r.from, contact.epub, session.pair);
    if (!payload) continue;
    mem.set(r.id, { id: r.id, from: r.from, ts: r.ts || payload.ts, ...payload });
    added = true;
  }
  bumpAck(contact.convId, maxTs(mem));
  if (added) emit('hydrated', { type: 'dm', id: contact.convId });
}

async function ingestDM(contact, node, soul) {
  if (!node || !node.c) return;
  const scope = dmScope(contact.convId);
  const ts = node.ts || 0;
  if (ts <= (horizons.get(scope) || 0)) return; // evicted region — don't resurrect
  const mem = dmStore.get(contact.convId);
  if (mem.has(soul)) return;
  const payload = await openDM(node.c, node.from, contact.epub, session.pair);
  if (!payload) return; // can't decrypt/verify — ignore, don't archive
  await store.putMessage({ id: soul, scope, ts: ts || payload.ts, from: node.from, ct: node.c, kind: 'dm' });
  const msg = { id: soul, from: node.from, ts: ts || payload.ts, ...payload };
  mem.set(soul, msg);
  bumpAck(contact.convId, msg.ts);
  emit('dm-message', { convId: contact.convId, msg });
  scheduleEviction();
}

export async function sendDM(contact, payload) {
  const ts = Date.now();
  payload = { ts, from: session.pub, ...payload };
  const ciphertext = await sealDM(payload, contact.epub, session.pair);
  root.get('dm').get(contact.convId).get('messages').get(makeMsgKey(ts)).put({
    c: ciphertext, from: session.pub, ts,
  });
}

// ---------------------------------------------------------------------------
// Shared rooms
// ---------------------------------------------------------------------------
export const rooms = new Map();   // roomId -> {roomId, name, key, createdBy}
const roomStore = new Map();      // roomId -> Map(soul -> message)
const roomSubscribed = new Set();

function persistRooms() {
  store.kvSet(ukey('rooms'), [...rooms.values()]).catch(() => {});
}

export async function createRoom(name) {
  const roomId = 'room_' + (await newRoomKey()).replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  const key = await newRoomKey();
  const record = { roomId, name, key, createdBy: session.pub };
  await persistRoom(record);
  return record;
}

async function persistRoom(record) {
  rooms.set(record.roomId, record);
  persistRooms();
  // Cross-device sync of our membership + key (encrypted to ourselves).
  const sealed = await sealToSelf(record, session.pair);
  user.get('rooms').get(record.roomId).put({ blob: sealed });
  emit('rooms', [...rooms.values()]);
  subscribeRoom(record);
}

export async function renameRoom(roomId, name) {
  const rec = rooms.get(roomId);
  if (rec) await persistRoom({ ...rec, name });
}

export function unjoinRoom(roomId) {
  user.get('rooms').get(roomId).put({ blob: null }); // tombstone our membership only
  rooms.delete(roomId);
  roomSubscribed.delete(roomId);
  persistRooms();
  emit('rooms', [...rooms.values()]);
}

function subscribeRooms() {
  user.get('rooms').map().on(async (node, roomId) => {
    if (!node || !node.blob) {
      if (rooms.delete(roomId)) { persistRooms(); emit('rooms', [...rooms.values()]); }
      return;
    }
    if (rooms.has(roomId)) return;
    const rec = await openFromSelf(node.blob, session.pair);
    if (rec && rec.key) {
      rooms.set(roomId, rec);
      persistRooms();
      emit('rooms', [...rooms.values()]);
      subscribeRoom(rec);
    }
  });
}

export function roomMessages(roomId) {
  return [...(roomStore.get(roomId)?.values() || [])].sort((a, b) => a.ts - b.ts);
}

async function subscribeRoom(record) {
  if (roomSubscribed.has(record.roomId)) return;
  roomSubscribed.add(record.roomId);
  if (!roomStore.has(record.roomId)) roomStore.set(record.roomId, new Map());

  root.get('rooms').get(record.roomId).get('messages').map().on((node, soul) => {
    ingestRoom(record, node, soul);
  });
  await hydrateRoom(record);
}

async function hydrateRoom(record) {
  const scope = roomScope(record.roomId);
  const horizon = horizons.get(scope) || 0;
  const rows = await store.messagesForScope(scope);
  const mem = roomStore.get(record.roomId);
  let added = false;
  for (const r of rows) {
    if (mem.has(r.id) || r.ts <= horizon) continue;
    const payload = await openRoom(r.ct, r.from, record.key);
    if (!payload) continue;
    mem.set(r.id, { id: r.id, from: r.from, ts: r.ts || payload.ts, ...payload });
    added = true;
  }
  bumpAck(record.roomId, maxTs(mem));
  if (added) emit('hydrated', { type: 'room', id: record.roomId });
}

async function ingestRoom(record, node, soul) {
  if (!node || !node.c) return;
  const scope = roomScope(record.roomId);
  const ts = node.ts || 0;
  if (ts <= (horizons.get(scope) || 0)) return;
  const mem = roomStore.get(record.roomId);
  if (mem.has(soul)) return;
  const payload = await openRoom(node.c, node.from, record.key);
  if (!payload) return;
  await store.putMessage({ id: soul, scope, ts: ts || payload.ts, from: node.from, ct: node.c, kind: 'room' });
  const msg = { id: soul, from: node.from, ts: ts || payload.ts, ...payload };
  mem.set(soul, msg);
  bumpAck(record.roomId, msg.ts);
  emit('room-message', { roomId: record.roomId, msg });
  scheduleEviction();
}

export async function sendRoom(record, payload) {
  const ts = Date.now();
  payload = { ts, from: session.pub, name: session.displayName, ...payload };
  const ciphertext = await sealRoom(payload, record.key, session.pair);
  root.get('rooms').get(record.roomId).get('messages').get(makeMsgKey(ts)).put({
    c: ciphertext, from: session.pub, ts,
  });
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------
export async function sendInvite(contact, roomRecord) {
  await sendDM(contact, {
    type: 'invite',
    roomId: roomRecord.roomId,
    roomName: roomRecord.name,
    key: roomRecord.key,
    body: `Invitation to join room "${roomRecord.name}"`,
  });
}

export async function acceptInvite(invite) {
  if (rooms.has(invite.roomId)) return rooms.get(invite.roomId);
  const record = { roomId: invite.roomId, name: invite.roomName, key: invite.key, createdBy: invite.from };
  await persistRoom(record);
  return record;
}

// ---------------------------------------------------------------------------
// Unread tracking
// ---------------------------------------------------------------------------
export const lastRead = new Map();

function persistReads() {
  store.kvSet(ukey('reads'), Object.fromEntries(lastRead)).catch(() => {});
}

export function initReads() {
  // Cross-device read marks (best-effort) from Gun user space.
  user.get('reads').map().on((ts, id) => {
    if (typeof ts === 'number' && ts > (lastRead.get(id) || 0)) {
      lastRead.set(id, ts);
      persistReads();
    }
  });
}

export function markRead(id) {
  const ts = Date.now();
  lastRead.set(id, ts);
  persistReads();
  user.get('reads').get(id).put(ts);
}

export function unreadCount(id, messages) {
  const since = lastRead.get(id) || 0;
  return messages.filter((m) => m.ts > since && m.from !== session.pub).length;
}

// ---------------------------------------------------------------------------
// Anti-resurrection horizons + pressure eviction
// ---------------------------------------------------------------------------
let horizons = new Map(); // scope -> ts below which messages were evicted

function persistHorizons() {
  store.kvSet(ukey('horizons'), Object.fromEntries(horizons)).catch(() => {});
}

function setHorizon(scope, ts) {
  horizons.set(scope, Math.max(horizons.get(scope) || 0, ts));
  persistHorizons();
}

// Drop evicted records from the in-memory caches too, then refresh the UI.
function dropFromMemory(records) {
  let touched = false;
  for (const r of records) {
    const [, kind, id] = r.scope.match(/\|(\w+):(.+)$/) || [];
    if (kind === 'dm') { dmStore.get(id)?.delete(r.id); touched = true; }
    else if (kind === 'room') { roomStore.get(id)?.delete(r.id); touched = true; }
  }
  if (touched) emit('evicted', {});
}

const evictIO = {
  estimate: () => store.estimate(),
  count: () => store.count(),
  oldest: (n) => store.oldest(n),
  remove: async (records) => {
    await store.deleteMessages(records.map((r) => r.id));
    dropFromMemory(records);
  },
  setHorizon: (scope, ts) => setHorizon(scope, ts),
};

let evictScheduled = false;
function scheduleEviction() {
  if (evictScheduled) return;
  evictScheduled = true;
  setTimeout(async () => {
    evictScheduled = false;
    try { await store.runEviction(evictIO); } catch (e) { console.error('eviction', e); }
  }, 5000);
}

let evictTimer = null;
function startEvictionTimer() {
  if (evictTimer) return;
  evictTimer = setInterval(scheduleEviction, 120000); // periodic safety sweep
}

// ---------------------------------------------------------------------------
// Delivery ack watermarks (Step 2). Each reader publishes a tiny SIGNED record
// acks/<scope>/<myPub> = { upTo, w } stating "I have durably received this
// conversation up to timestamp `upTo`". The relay reads these to learn when a
// message has reached everyone and can be reclaimed early (server janitor).
//
// `upTo` only ever increases (monotonic), so re-publishing on boot is safe and
// never regresses. scope = the SHARED id (convId / roomId).
// ---------------------------------------------------------------------------
const ackHigh = new Map();    // scope -> highest ts durably received
const ackDirty = new Set();
let ackTimer = null;

function maxTs(memMap) {
  let m = 0;
  for (const v of memMap.values()) if (v.ts > m) m = v.ts;
  return m;
}

function bumpAck(scope, ts) {
  if (!ts || ts <= (ackHigh.get(scope) || 0)) return;
  ackHigh.set(scope, ts);
  ackDirty.add(scope);
  if (!ackTimer) ackTimer = setTimeout(flushAcks, 4000);
}

async function flushAcks() {
  ackTimer = null;
  const scopes = [...ackDirty];
  ackDirty.clear();
  for (const scope of scopes) {
    const upTo = ackHigh.get(scope);
    const w = await signClaim({ scope, upTo, pub: session.pub }, session.pair);
    root.get('acks').get(scope).get(session.pub).put({ upTo, w });
  }
}
