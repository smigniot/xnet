// db.js
// -----
// All Gun graph access lives here: identity, the public username directory,
// contacts, one-on-one messages, shared rooms, invitations and unread state.
//
// Privacy notes (see also PROJECT.md "surveillance should be impossible"):
//   * Message bodies are always encrypted on the client before they touch Gun.
//   * Your private state (room keys, contacts) is stored in your Gun user space
//     which is world-READABLE but only owner-WRITABLE, so we additionally
//     encrypt those values to ourselves. Room keys NEVER appear in plaintext.
//   * Known, documented metadata leaks: the username directory maps alias->pub
//     (that was the chosen trade-off for easy discovery), and outer message
//     timestamps are in clear so messages can be ordered. Content stays private.

import {
  conversationId, newRoomKey, sealDM, openDM, sealRoom, openRoom,
  sealToSelf, openFromSelf,
} from './crypto.js';

const Gun = window.Gun;

// Talk to the relay we were served from. Gun keeps working peer-to-peer if it
// later goes away.
const peers = [location.origin.replace(/\/$/, '') + '/gun'];
export const gun = Gun({ peers, localStorage: true, radisk: true });
const root = gun.get('xnet');
export const user = gun.user();

// ---------------------------------------------------------------------------
// Tiny event bus so the UI can react without reaching into Gun directly.
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
// Session / identity
// ---------------------------------------------------------------------------
export const session = {
  pub: null,
  epub: null,
  alias: null,
  displayName: null,
  pair: null,
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

// Restore a previous session (Gun persists it in localStorage).
export function recall() {
  return new Promise((resolve) => {
    user.recall({ sessionStorage: false }, () => {
      if (isLoggedIn()) {
        loadSessionFromUser();
        afterAuth().then(() => resolve(true));
      } else {
        resolve(false);
      }
    });
  });
}

export function signup(alias, displayName, pass) {
  alias = alias.trim().toLowerCase();
  return new Promise((resolve, reject) => {
    if (!/^[a-z0-9_]{3,20}$/.test(alias)) {
      return reject(new Error('Username must be 3-20 chars: a-z, 0-9, underscore.'));
    }
    // First-come-first-served on the public directory.
    root.get('directory').get(alias).once((existing) => {
      if (existing && existing.pub) {
        return reject(new Error('That username is taken.'));
      }
      user.create(alias, pass, (ack) => {
        if (ack.err) return reject(new Error(ack.err));
        user.auth(alias, pass, async (ack2) => {
          if (ack2.err) return reject(new Error(ack2.err));
          loadSessionFromUser();
          session.displayName = displayName || alias;
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
      await afterAuth();
      resolve(session);
    });
  });
}

// Log in with an exported keypair (device migration / backup recovery).
export function loginWithPair(pair) {
  return new Promise((resolve, reject) => {
    user.auth(pair, async (ack) => {
      if (ack.err) return reject(new Error(ack.err));
      loadSessionFromUser();
      await afterAuth();
      resolve(session);
    });
  });
}

export function logout() {
  user.leave();
  session.pub = session.epub = session.alias = session.displayName = session.pair = null;
  emit('auth', null);
}

// The exact bytes a user should back up to move devices.
export function exportPair() {
  return JSON.stringify(user._.sea, null, 2);
}

// Publish/refresh our public directory entry (alias -> pub/epub/displayName).
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
  // Load our display name from our profile (falls back to alias).
  await new Promise((res) => {
    user.get('profile').once((p) => {
      session.displayName = (p && p.displayName) || session.alias;
      res();
    });
  });
  emit('auth', session);
  subscribeContacts();
  subscribeRooms();
  subscribeInbox();
}

// ---------------------------------------------------------------------------
// Inbox: how a recipient discovers a conversation someone started with them.
// When I add/contact you, I drop my PUBLIC card (alias/displayName/pub/epub —
// all already public) into your inbox. You auto-add me so the conversation and
// its unread badge appear, and you can decrypt my messages.
// Metadata note: like the directory, the inbox reveals who contacted whom; it
// never reveals content. Replace with share-links to remove this leak.
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
// Directory lookup (search people by username)
// ---------------------------------------------------------------------------
export function lookup(alias) {
  alias = alias.trim().toLowerCase();
  return new Promise((resolve) => {
    root.get('directory').get(alias).once((entry) => {
      if (entry && entry.pub && entry.epub) {
        resolve({ alias: entry.alias, displayName: entry.displayName, pub: entry.pub, epub: entry.epub });
      } else {
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Contacts (our private address book, keyed by conversation id so raw
// pubkeys don't sit in plaintext under our user node).
// ---------------------------------------------------------------------------
export const contacts = new Map(); // convId -> {alias, displayName, pub, epub, convId}

export async function addContact(person, fromInbox = false) {
  const convId = await conversationId(session.pub, person.pub);
  const record = { ...person, convId };
  const sealed = await sealToSelf(record, session.pair);
  user.get('contacts').get(convId).put({ blob: sealed });
  contacts.set(convId, record);
  // Let them discover me too (unless we're already reacting to their card).
  if (!fromInbox) announceTo(person.pub);
  emit('contacts', [...contacts.values()]);
  subscribeDM(record);
  return record;
}

function subscribeContacts() {
  user.get('contacts').map().on(async (node, convId) => {
    if (!node || !node.blob) {
      if (contacts.delete(convId)) emit('contacts', [...contacts.values()]);
      return;
    }
    const rec = await openFromSelf(node.blob, session.pair);
    if (rec) {
      contacts.set(convId, rec);
      emit('contacts', [...contacts.values()]);
      subscribeDM(rec); // start listening to this conversation
    }
  });
}

export async function getOrAddContact(person) {
  const convId = await conversationId(session.pub, person.pub);
  if (contacts.has(convId)) return contacts.get(convId);
  return addContact(person);
}

// ---------------------------------------------------------------------------
// One-on-one messages
// ---------------------------------------------------------------------------
// In-memory message store: convId -> Map(soul -> message)
const dmStore = new Map();
const dmSubscribed = new Set();

export function dmMessages(convId) {
  return [...(dmStore.get(convId)?.values() || [])].sort((a, b) => a.ts - b.ts);
}

function subscribeDM(contact) {
  if (dmSubscribed.has(contact.convId)) return;
  dmSubscribed.add(contact.convId);
  if (!dmStore.has(contact.convId)) dmStore.set(contact.convId, new Map());

  root.get('dm').get(contact.convId).get('messages').map().on(async (node, soul) => {
    if (!node || !node.c) return;
    const payload = await openDM(node.c, node.from, contact.epub, session.pair);
    if (!payload) return; // couldn't decrypt/verify -> ignore
    const msg = { id: soul, from: node.from, ts: node.ts || payload.ts, ...payload };
    const store = dmStore.get(contact.convId);
    if (store.has(soul)) return;
    store.set(soul, msg);
    emit('dm-message', { convId: contact.convId, msg });
  });
}

export async function sendDM(contact, payload) {
  payload = { ts: Date.now(), from: session.pub, ...payload };
  const ciphertext = await sealDM(payload, contact.epub, session.pair);
  root.get('dm').get(contact.convId).get('messages').set({
    c: ciphertext,
    from: session.pub,
    ts: payload.ts,
  });
}

// ---------------------------------------------------------------------------
// Shared rooms
// ---------------------------------------------------------------------------
// Our joined rooms (private): roomId -> {roomId, name, key, createdBy}
export const rooms = new Map();
const roomStore = new Map(); // roomId -> Map(soul -> message)
const roomSubscribed = new Set();

export async function createRoom(name) {
  const roomId = 'room_' + (await newRoomKey()).replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  const key = await newRoomKey();
  const record = { roomId, name, key, createdBy: session.pub };
  await persistRoom(record);
  return record;
}

async function persistRoom(record) {
  const sealed = await sealToSelf(record, session.pair);
  user.get('rooms').get(record.roomId).put({ blob: sealed });
  rooms.set(record.roomId, record);
  emit('rooms', [...rooms.values()]);
}

export async function renameRoom(roomId, name) {
  const rec = rooms.get(roomId);
  if (!rec) return;
  await persistRoom({ ...rec, name });
}

export function unjoinRoom(roomId) {
  // Tombstone our membership. The room and its history are never deleted.
  user.get('rooms').get(roomId).put({ blob: null });
  rooms.delete(roomId);
  roomSubscribed.delete(roomId);
  emit('rooms', [...rooms.values()]);
}

function subscribeRooms() {
  user.get('rooms').map().on(async (node, roomId) => {
    if (!node || !node.blob) {
      if (rooms.delete(roomId)) emit('rooms', [...rooms.values()]);
      return;
    }
    const rec = await openFromSelf(node.blob, session.pair);
    if (rec && rec.key) {
      rooms.set(roomId, rec);
      emit('rooms', [...rooms.values()]);
      subscribeRoom(rec);
    }
  });
}

export function roomMessages(roomId) {
  return [...(roomStore.get(roomId)?.values() || [])].sort((a, b) => a.ts - b.ts);
}

function subscribeRoom(record) {
  if (roomSubscribed.has(record.roomId)) return;
  roomSubscribed.add(record.roomId);
  if (!roomStore.has(record.roomId)) roomStore.set(record.roomId, new Map());

  root.get('rooms').get(record.roomId).get('messages').map().on(async (node, soul) => {
    if (!node || !node.c) return;
    const payload = await openRoom(node.c, node.from, record.key);
    if (!payload) return;
    const msg = { id: soul, from: node.from, ts: node.ts || payload.ts, ...payload };
    const store = roomStore.get(record.roomId);
    if (store.has(soul)) return;
    store.set(soul, msg);
    emit('room-message', { roomId: record.roomId, msg });
  });
}

export async function sendRoom(record, payload) {
  payload = { ts: Date.now(), from: session.pub, name: session.displayName, ...payload };
  const ciphertext = await sealRoom(payload, record.key, session.pair);
  root.get('rooms').get(record.roomId).get('messages').set({
    c: ciphertext,
    from: session.pub,
    ts: payload.ts,
  });
}

// ---------------------------------------------------------------------------
// Invitations: send a room key to a contact over the (already encrypted) DM
// channel. This IS the "re-encrypt the symmetric key with Bob's key" step,
// because the DM seal is an ECDH encryption to Bob.
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
  const record = {
    roomId: invite.roomId,
    name: invite.roomName,
    key: invite.key,
    createdBy: invite.from,
  };
  await persistRoom(record);
  return record;
}

// ---------------------------------------------------------------------------
// Unread tracking. lastRead[id] = timestamp; persisted in user space.
// ---------------------------------------------------------------------------
export const lastRead = new Map();

export function initReads() {
  user.get('reads').map().on((ts, id) => {
    if (typeof ts === 'number') lastRead.set(id, ts);
  });
}

export function markRead(id) {
  const ts = Date.now();
  lastRead.set(id, ts);
  user.get('reads').get(id).put(ts);
}

export function unreadCount(id, messages) {
  const since = lastRead.get(id) || 0;
  return messages.filter((m) => m.ts > since && m.from !== session.pub).length;
}
