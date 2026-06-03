// app.js
// ------
// UI + wiring. Talks only to db.js (graph/crypto) and markdown.js (rendering).

import * as db from './db.js';
import { renderMarkdown } from './markdown.js';

const MAX_ATTACH = 2 * 1024 * 1024; // 2 MB — keeps Gun's websocket happy.

// ---- tiny DOM helpers ----
const $ = (sel) => document.querySelector(sel);
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return n;
}
const initials = (s) => (s || '?').trim().slice(0, 2).toUpperCase();
const fmtTime = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

// Lightweight modal. Returns a close() fn; click on the backdrop or Esc closes.
function openModal(title, bodyNode) {
  const card = el('div', { class: 'modal-card' },
    el('div', { class: 'modal-head' }, el('h3', {}, title),
      el('button', { class: 'icon-btn', onclick: () => close() }, '✕')),
    bodyNode);
  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } }, card);
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return close;
}

function toast(text) {
  const t = el('div', { class: 'toast' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

// ---- current selection ----
let current = null; // { type:'dm'|'room', id, contact?, room? }

// =====================================================================
// AUTH SCREEN
// =====================================================================
function setupAuth() {
  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.tab;
      $('#form-login').classList.toggle('hidden', which !== 'login');
      $('#form-signup').classList.toggle('hidden', which !== 'signup');
      $('#auth-error').textContent = '';
    })
  );

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await db.login(f.alias.value, f.pass.value);
    } catch (err) { $('#auth-error').textContent = err.message; }
  });

  $('#form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await db.signup(f.alias.value, f.displayName.value, f.pass.value);
    } catch (err) { $('#auth-error').textContent = err.message; }
  });

  $('#import-key').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const pair = JSON.parse(await file.text());
      await db.loginWithPair(pair);
    } catch (err) { $('#auth-error').textContent = 'Could not import keypair: ' + err.message; }
  });
}

// =====================================================================
// SHELL
// =====================================================================
function showApp() {
  $('#auth').classList.add('hidden');
  $('#main').classList.remove('hidden');
  $('#me-name').textContent = db.session.displayName;
  $('#me-alias').textContent = '@' + db.session.alias;
  $('#me-avatar').textContent = initials(db.session.displayName);
  db.initReads();
  renderContacts([...db.contacts.values()]);
  renderRooms([...db.rooms.values()]);
}

function setupShell() {
  // header menu
  $('#menu-btn').addEventListener('click', () => $('#menu').classList.toggle('hidden'));
  $('#logout').addEventListener('click', () => location.reload());
  $('#export-key').addEventListener('click', () => {
    const blob = new Blob([db.exportPair()], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `xnet-${db.session.alias}-keypair.json` });
    a.click();
    $('#menu').classList.add('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu') && e.target.id !== 'menu-btn') $('#menu').classList.add('hidden');
    if (!e.target.closest('#chat-menu') && e.target.id !== 'chat-menu-btn') $('#chat-menu').classList.add('hidden');
  });

  // search
  let timer;
  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    if (!q) { $('#search-results').innerHTML = ''; return; }
    timer = setTimeout(() => doSearch(q), 250);
  });

  // new room
  $('#new-room').addEventListener('click', async () => {
    const name = prompt('Name your new room');
    if (!name) return;
    const room = await db.createRoom(name.trim());
    openRoom(room);
  });

  // composer
  const input = $('#composer-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendText(); });
  $('#attach-btn').addEventListener('click', () => $('#attach-file').click());
  $('#attach-file').addEventListener('change', onAttach);

  // chat menu + back
  $('#chat-menu-btn').addEventListener('click', () => $('#chat-menu').classList.toggle('hidden'));
  $('#back-btn').addEventListener('click', () => $('#main').classList.remove('show-chat'));

  // connectivity banner
  const banner = $('#net-banner');
  const updateNet = () => {
    if (navigator.onLine) banner.classList.add('hidden');
    else { banner.textContent = 'Offline — messages will sync with peers when you reconnect.'; banner.classList.remove('hidden'); }
  };
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();
}

// =====================================================================
// SEARCH / CONTACTS
// =====================================================================
async function doSearch(q) {
  const box = $('#search-results');
  const person = await db.lookup(q);
  box.innerHTML = '';
  if (!person) { box.append(el('div', { class: 'result' }, el('span', {}, 'No user @' + q.toLowerCase()))); return; }
  if (person.pub === db.session.pub) { box.append(el('div', { class: 'result' }, el('span', {}, 'That’s you!'))); return; }
  box.append(el('div', { class: 'result' },
    el('span', {}, `${person.displayName} `, el('small', { style: 'color:var(--muted)' }, '@' + person.alias)),
    el('button', { onclick: async () => {
      const contact = await db.getOrAddContact(person);
      $('#search-results').innerHTML = '';
      $('#search-input').value = '';
      openDM(contact);
    } }, 'Message')
  ));
}

function renderContacts(list) {
  const ul = $('#dm-list');
  ul.innerHTML = '';
  list.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
  for (const c of list) {
    const msgs = db.dmMessages(c.convId);
    const unread = db.unreadCount(c.convId, msgs);
    const last = msgs[msgs.length - 1];
    ul.append(convRow({
      active: current?.type === 'dm' && current.id === c.convId,
      avatar: initials(c.displayName),
      name: c.displayName,
      sub: last ? previewOf(last) : '@' + c.alias,
      unread,
      onclick: () => openDM(c),
    }));
  }
}

function renderRooms(list) {
  const ul = $('#room-list');
  ul.innerHTML = '';
  list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  for (const r of list) {
    const msgs = db.roomMessages(r.roomId);
    const unread = db.unreadCount(r.roomId, msgs);
    const last = msgs[msgs.length - 1];
    ul.append(convRow({
      active: current?.type === 'room' && current.id === r.roomId,
      avatar: '#',
      name: r.name,
      sub: last ? previewOf(last) : 'shared room',
      unread,
      onclick: () => openRoom(r),
    }));
  }
}

function previewOf(m) {
  if (m.type === 'image') return '📷 Image';
  if (m.type === 'file') return '📎 ' + (m.name || 'File');
  if (m.type === 'invite') return '✉️ Room invitation';
  return (m.body || '').replace(/\n/g, ' ').slice(0, 40);
}

function convRow({ active, avatar, name, sub, unread, onclick }) {
  return el('li', { class: 'conv' + (active ? ' active' : ''), onclick },
    el('span', { class: 'c-avatar' }, avatar),
    el('div', { class: 'c-main' },
      el('div', { class: 'c-name' }, name),
      el('div', { class: 'c-sub' }, sub)),
    unread ? el('span', { class: 'badge' }, String(unread)) : null
  );
}

// =====================================================================
// OPEN CONVERSATIONS
// =====================================================================
function openDM(contact) {
  current = { type: 'dm', id: contact.convId, contact };
  $('#chat-title').innerHTML = '';
  $('#chat-title').append(contact.displayName, el('small', {}, '@' + contact.alias + ' · end-to-end encrypted'));
  buildChatMenu();
  activateChat();
  renderMessages();
  db.markRead(contact.convId);
}

function openRoom(room) {
  current = { type: 'room', id: room.roomId, room };
  $('#chat-title').innerHTML = '';
  $('#chat-title').append(room.name, el('small', {}, 'shared room · end-to-end encrypted'));
  buildChatMenu();
  activateChat();
  renderMessages();
  db.markRead(room.roomId);
}

function activateChat() {
  $('#chat-empty').classList.add('hidden');
  $('#chat-active').classList.remove('hidden');
  $('#main').classList.add('show-chat');
  refreshLists();
}

function buildChatMenu() {
  const menu = $('#chat-menu');
  menu.innerHTML = '';
  if (current.type === 'dm') {
    menu.append(el('button', { onclick: () => inviteToRoomFlow(current.contact) }, 'Invite to a room…'));
  } else {
    menu.append(
      el('button', { onclick: () => inviteContactFlow(current.room) }, 'Invite a contact…'),
      el('button', { onclick: async () => {
        const name = prompt('Rename room', current.room.name);
        if (name) { await db.renameRoom(current.room.roomId, name.trim()); current.room.name = name.trim(); openRoom(current.room); }
      } }, 'Rename room'),
      el('button', { onclick: () => {
        if (confirm('Leave this room? You can be re-invited later.')) {
          db.unjoinRoom(current.room.roomId);
          current = null;
          $('#chat-active').classList.add('hidden');
          $('#chat-empty').classList.remove('hidden');
          $('#main').classList.remove('show-chat');
        }
      } }, 'Leave room')
    );
  }
}

// Invite a DM contact to one of *my* rooms — pick from my own rooms (mine, so
// listing them discloses nothing about other people).
function inviteToRoomFlow(contact) {
  $('#chat-menu').classList.add('hidden');
  const roomList = [...db.rooms.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!roomList.length) { toast('You have no rooms yet — create one with +'); return; }
  const list = el('div', { class: 'pick-list' });
  for (const r of roomList) {
    list.append(el('button', { class: 'pick-row', onclick: () => {
      db.sendInvite(contact, r);
      close();
      toast(`Invited ${contact.displayName} to “${r.name}”`);
      openDM(contact);
    } }, el('span', { class: 'c-avatar' }, '#'), el('span', {}, r.name)));
  }
  const close = openModal(`Invite ${contact.displayName} to a room`, list);
}

// Invite someone to a room by searching the username directory — no roster is
// shown, mirroring the way you start a private message.
function inviteContactFlow(room) {
  $('#chat-menu').classList.add('hidden');
  const input = el('input', { placeholder: 'Find someone by username…', autocomplete: 'off' });
  const results = el('div', { class: 'search-results' });
  const body = el('div', { class: 'modal-search' }, input, results);
  const close = openModal(`Invite someone to “${room.name}”`, body);
  input.focus();

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      const person = await db.lookup(q);
      results.innerHTML = '';
      if (!person) { results.append(el('div', { class: 'result' }, el('span', {}, 'No user @' + q.toLowerCase()))); return; }
      if (person.pub === db.session.pub) { results.append(el('div', { class: 'result' }, el('span', {}, 'That’s you!'))); return; }
      results.append(el('div', { class: 'result' },
        el('span', {}, `${person.displayName} `, el('small', { style: 'color:var(--muted)' }, '@' + person.alias)),
        el('button', { onclick: async () => {
          const contact = await db.getOrAddContact(person);
          await db.sendInvite(contact, room);
          close();
          toast(`Invitation sent to ${person.displayName}`);
        } }, 'Invite')
      ));
    }, 250);
  });
}

// =====================================================================
// MESSAGES
// =====================================================================
function currentMessages() {
  return current.type === 'dm' ? db.dmMessages(current.id) : db.roomMessages(current.id);
}

function renderMessages() {
  const wrap = $('#messages');
  wrap.innerHTML = '';
  for (const m of currentMessages()) wrap.append(renderMessage(m));
  wrap.scrollTop = wrap.scrollHeight;
}

function renderMessage(m) {
  const mine = m.from === db.session.pub;
  const who = mine ? 'You' : (current.type === 'room' ? (m.name || senderName(m.from)) : current.contact.displayName);

  let body;
  if (m.type === 'image') {
    body = el('div', { class: 'bubble' }, el('img', { src: m.body, alt: m.name || 'image' }));
  } else if (m.type === 'file') {
    body = el('div', { class: 'bubble' },
      el('a', { class: 'file-att', href: m.body, download: m.name || 'file' }, '📎 ', m.name || 'file'));
  } else if (m.type === 'invite') {
    const joined = db.rooms.has(m.roomId);
    body = el('div', { class: 'bubble' }, el('div', { class: 'invite' },
      el('div', {}, `✉️ Invitation to join room “${m.roomName}”`),
      mine ? el('small', { style: 'color:var(--muted)' }, 'You sent this invite.')
        : el('button', {
            disabled: joined ? '' : null,
            onclick: async (e) => {
              const room = await db.acceptInvite(m);
              e.target.textContent = 'Joined';
              e.target.disabled = true;
              openRoom(room);
            },
          }, joined ? 'Joined' : 'Accept invitation')
    ));
  } else {
    body = el('div', { class: 'bubble', html: renderMarkdown(m.body || '') });
  }

  return el('div', { class: 'msg' + (mine ? ' mine' : '') },
    body,
    el('div', { class: 'meta' }, `${who} · ${fmtTime(m.ts)}`)
  );
}

function senderName(pub) {
  for (const c of db.contacts.values()) if (c.pub === pub) return c.displayName;
  return '@' + pub.slice(0, 8);
}

async function sendText() {
  const input = $('#composer-input');
  const text = input.value.trim();
  if (!text || !current) return;
  input.value = '';
  input.style.height = 'auto';
  const payload = { type: 'text', body: text };
  if (current.type === 'dm') await db.sendDM(current.contact, payload);
  else await db.sendRoom(current.room, payload);
}

async function onAttach(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !current) return;
  if (file.size > MAX_ATTACH) { alert('File too large (max 2 MB for now).'); return; }
  const dataUrl = await new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(file);
  });
  const isImage = file.type.startsWith('image/');
  const payload = { type: isImage ? 'image' : 'file', body: dataUrl, name: file.name, mime: file.type };
  if (current.type === 'dm') await db.sendDM(current.contact, payload);
  else await db.sendRoom(current.room, payload);
}

// =====================================================================
// LIVE EVENTS
// =====================================================================
function refreshLists() {
  renderContacts([...db.contacts.values()]);
  renderRooms([...db.rooms.values()]);
}

db.on('auth', (s) => { if (s) showApp(); });
db.on('contacts', refreshLists);
db.on('rooms', refreshLists);

// History loaded from IndexedDB (offline boot / lazy hydrate): re-render if the
// affected conversation is open.
db.on('hydrated', ({ type, id }) => {
  if (current && current.type === type && current.id === id) renderMessages();
  refreshLists();
});

// Pressure eviction dropped old messages locally: refresh the open view + lists.
db.on('evicted', () => {
  if (current) renderMessages();
  refreshLists();
});

db.on('dm-message', ({ convId, msg }) => {
  if (current?.type === 'dm' && current.id === convId) {
    const wrap = $('#messages');
    const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 40;
    wrap.append(renderMessage(msg));
    if (atBottom) wrap.scrollTop = wrap.scrollHeight;
    db.markRead(convId);
  }
  refreshLists();
});

db.on('room-message', ({ roomId, msg }) => {
  if (current?.type === 'room' && current.id === roomId) {
    const wrap = $('#messages');
    const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 40;
    wrap.append(renderMessage(msg));
    if (atBottom) wrap.scrollTop = wrap.scrollHeight;
    db.markRead(roomId);
  }
  refreshLists();
});

// =====================================================================
// BOOT
// =====================================================================
setupAuth();
setupShell();
db.recall(); // restores a prior session and fires 'auth' if successful
