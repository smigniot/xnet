/* Xnet — UI / controllers (Phase 4). Adds first-contact QR pairing and live messaging over the
   gun mesh (net.js). Local-only data (identity, rooms, secrets, membership) via model.js. */
(function (root) {
  'use strict';
  var Xnet = root.Xnet = root.Xnet || {};

  var $ = function (s, e) { return (e || document).querySelector(s); };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag); attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  var fmt = function (ts) { return new Date(ts).toLocaleString(); };
  var shortPub = function (p) { return (p || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6); };

  var state = { mode: null, view: 'list', roomId: null, rerender: function () {} };
  var connector = null;
  var connectedPeers = {};   // peerSignPk -> true (direct mesh links we hold)
  var dialing = {};          // peerSignPk -> true (in-flight mesh-signaled dials)

  // Register a freshly-opened peer link (from QR pairing OR mesh signaling) and track the peer.
  function addPeerLink(link, peerSignPk) {
    if (peerSignPk) connectedPeers[peerSignPk] = true;
    if (peerSignPk) delete dialing[peerSignPk];
    if (typeof link.onclose === 'function') { var prev = link.onclose; link.onclose = function () { if (peerSignPk) delete connectedPeers[peerSignPk]; prev(); updatePeers(); state.rerender(); }; }
    else link.onclose = function () { if (peerSignPk) delete connectedPeers[peerSignPk]; updatePeers(); state.rerender(); };
    Xnet.net.addLink(link);
    updatePeers(); state.rerender();
  }
  // Best-effort: dial a room member we aren't linked to yet, over the existing mesh (no QR).
  function tryIntroduce(member) {
    if (!member || !member.signPk || !member.boxPk) return;
    var me = Xnet.model.getIdentity().signPk;
    if (member.signPk === me || connectedPeers[member.signPk] || dialing[member.signPk] || !connector) return;
    dialing[member.signPk] = true;
    connector.connectTo(member.signPk, member.boxPk).catch(function () { delete dialing[member.signPk]; });
  }
  function setView(node) { var v = $('#view'); v.innerHTML = ''; v.appendChild(node); updatePeers(); }
  function updatePeers() { var p = $('#peers'); if (p) p.textContent = Xnet.net.peerCount() ? ('● ' + Xnet.net.peerCount() + ' peer' + (Xnet.net.peerCount() > 1 ? 's' : '')) : '○ offline'; }

  // ============================ room list ============================
  async function showList() {
    state.view = 'list'; state.roomId = null;
    var rooms = await Xnet.model.joinedRooms();
    var wrap = el('div', { class: 'view' });
    wrap.appendChild(el('div', { class: 'rowbar' }, [
      el('h2', { text: 'Rooms' }), el('span', { class: 'flex' }),
      el('button', { class: 'secondary', text: 'Join', onclick: joinDialog }),
      el('button', { text: '+ Create', onclick: createRoomPrompt })
    ]));
    if (state.mode === 'ephemeral')
      wrap.appendChild(el('div', { class: 'banner', html: '<b>Ephemeral session</b> — nothing is saved. Settings → download the app to run it persistently.' }));

    if (!rooms.length) wrap.appendChild(el('div', { class: 'empty', text: 'No rooms yet. Create one, or Join via QR.' }));
    else {
      var list = el('div', { class: 'list' });
      rooms.forEach(function (r) {
        var unread = Xnet.net.unread(r.room.id, r.membership.lastReadTs, r.membership.evictHorizonTs);
        var row = el('div', { class: 'list-row', onclick: function () { showRoom(r.room.id); } }, [
          el('div', { class: 'list-main' }, [
            el('div', { class: 'list-title', text: r.room.name }),
            el('div', { class: 'list-sub', text: 'created ' + fmt(r.room.createdAt) })
          ])
        ]);
        if (unread > 0) row.appendChild(el('span', { class: 'badge-count', text: String(unread) }));
        row.appendChild(el('button', { class: 'mini', text: '⤢', title: 'Share (QR)', onclick: function (e) { e.stopPropagation(); shareDialog(r.room.id); } }));
        row.appendChild(el('button', { class: 'mini', text: '✎', title: 'Rename', onclick: function (e) { e.stopPropagation(); renamePrompt(r.room); } }));
        row.appendChild(el('button', { class: 'mini', text: '⏏', title: 'Unjoin', onclick: function (e) { e.stopPropagation(); unjoin(r.room); } }));
        list.appendChild(row);
      });
      wrap.appendChild(list);
    }
    setView(wrap);
    state.rerender = function () { if (state.view === 'list') showList(); };
  }
  async function createRoomPrompt() {
    var name = window.prompt('Room name:', 'general'); if (name === null) return;
    var room = await Xnet.model.createRoom(name);
    var b = await Xnet.model.roomBundle(room.id);
    Xnet.net.publishMeta(room); Xnet.net.addMember(room.id, Xnet.model.selfMember());
    watchRoomMembers(room.id, b.secret, b.membership.evictHorizonTs);
    showList();
  }
  async function renamePrompt(room) {
    var name = window.prompt('Rename room:', room.name); if (name === null) return;
    var r = await Xnet.model.renameRoom(room.id, name); if (r) Xnet.net.publishMeta(r); showList();
  }
  async function unjoin(room) {
    if (!window.confirm('Unjoin "' + room.name + '"? Hidden locally, never deleted.')) return;
    await Xnet.model.unjoinRoom(room.id); showList();
  }

  // ============================ room view ============================
  async function showRoom(roomId) {
    var b = await Xnet.model.roomBundle(roomId);
    if (!b.room) return showList();
    state.view = 'room'; state.roomId = roomId;
    watchRoomMembers(roomId, b.secret, b.membership.evictHorizonTs);

    var msgsBox = el('div', { class: 'messages' });
    var input = el('input', { class: 'msg-input', type: 'text', placeholder: 'Message…', autocomplete: 'off' });

    var wrap = el('div', { class: 'view room' }, [
      el('div', { class: 'rowbar' }, [
        el('button', { class: 'mini', text: '←', title: 'Back', onclick: showList }),
        el('h2', { text: b.room.name }), el('span', { class: 'flex' }),
        el('button', { class: 'secondary', text: '⤢ Share', onclick: function () { shareDialog(roomId); } })
      ]),
      msgsBox,
      el('form', { class: 'composer', onsubmit: function (e) { e.preventDefault(); doSend(); } }, [input, el('button', { text: 'Send' })])
    ]);
    setView(wrap);

    function render() {
      var msgs = Xnet.net.messages(roomId, b.membership.evictHorizonTs);
      msgsBox.innerHTML = '';
      if (!msgs.length) msgsBox.appendChild(el('div', { class: 'empty', text: 'No messages yet. Say hello.' }));
      var me = Xnet.model.getIdentity().signPk;
      msgs.forEach(function (m) {
        var mine = m.authorPub === me;
        msgsBox.appendChild(el('div', { class: 'msg' + (mine ? ' mine' : '') }, [
          el('div', { class: 'msg-meta', text: (mine ? 'you' : shortPub(m.authorPub)) + ' · ' + fmt(m.ts) + (m.verified ? '' : ' · ⚠') }),
          el('div', { class: 'msg-body', text: m.text == null ? '⁉ [unable to decrypt]' : m.text })
        ]));
      });
      msgsBox.scrollTop = msgsBox.scrollHeight;
    }
    function doSend() {
      var t = input.value.trim(); if (!t) return; input.value = '';
      Xnet.net.send(roomId, b.secret, Xnet.model.getIdentity(), t);
      // optimistic: our own publish will echo back through the cache subscription
    }
    state.rerender = function () { if (state.view === 'room' && state.roomId === roomId) render(); };
    render(); await Xnet.model.markRead(roomId); input.focus();
  }

  // ============================ pairing: Share (Alice) ============================
  async function shareDialog(roomId) {
    var b = await Xnet.model.roomBundle(roomId);
    var id = Xnet.model.getIdentity(), settings = Xnet.model.getSettings();
    var body = el('div', {}, [el('div', { class: 'muted small', text: 'Generating offer (gathering network candidates)…' })]);
    var modal = openModal('Share "' + b.room.name + '"', body);
    var session;
    try { session = await Xnet.signaling.createOffer(settings, id, { id: b.room.id, secret: b.secret, name: b.room.name }); }
    catch (e) { body.innerHTML = ''; body.appendChild(el('div', { class: 'err', text: 'Could not create offer: ' + (e.message || e) })); return; }

    body.innerHTML = '';
    body.appendChild(el('p', { class: 'muted small', html: '<b>Step 1.</b> Send this <b>offer</b> to your friend — copy the text, download the file, or let them scan the QR with their phone camera. They open <b>Join</b> and paste it.' }));
    body.appendChild(inviteBlock(session.invite));
    body.appendChild(el('p', { class: 'muted small', html: '<b>Step 2.</b> Paste the <b>answer</b> they send back, then press Connect:' }));
    body.appendChild(receiveBlock('answer', async function (text, status) {
      var r = await Xnet.signaling.finishOffer(session.pc, text);
      status.textContent = 'Answer applied — waiting for the channel to open…';
      await Xnet.signaling.whenOpen(session.dc);
      await onPaired(session.dc, r.peerPub, { id: b.room.id, secret: b.secret, name: b.room.name });
      status.textContent = '✓ Connected. You can close this and chat.'; status.className = 'ok-box';
    }));
  }

  // ============================ pairing: Join (Bob) ============================
  function joinDialog() {
    var body = el('div', {});
    openModal('Join a room', body);
    body.appendChild(el('p', { class: 'muted small', html: '<b>Step 1.</b> Paste the <b>offer</b> your friend sent (or upload the file), then press Connect:' }));
    body.appendChild(receiveBlock('offer', async function (text, status) {
      var id = Xnet.model.getIdentity(), settings = Xnet.model.getSettings();
      var accepted = await Xnet.signaling.acceptOffer(settings, id, text);   // throws -> receiveBlock shows error
      body.innerHTML = '';
      body.appendChild(el('p', { class: 'muted small', html: '<b>Step 2.</b> Send this <b>answer</b> back to your friend (they paste it into their Share dialog and press Connect):' }));
      body.appendChild(inviteBlock(accepted.answer));
      var st = el('div', { class: 'muted small', text: 'Waiting for the connection to open…' }); body.appendChild(st);
      try {
        var dc = await accepted.dcPromise;
        await Xnet.signaling.whenOpen(dc);
        await Xnet.model.joinFromInvite(accepted.room);
        await onPaired(dc, accepted.peerPub, accepted.room);
        st.textContent = '✓ Connected and joined "' + (accepted.room.name || 'room') + '". You can close this.'; st.className = 'ok-box';
      } catch (e) { st.textContent = 'Connection failed: ' + (e.message || e); st.className = 'err'; }
    }));
  }

  // Common: a data channel just opened with a peer (first contact via QR).
  async function onPaired(dc, peerPub, room) {
    addPeerLink(Xnet.signaling.channelLink(dc), peerPub.signPk);
    await Xnet.model.addContact({ signPk: peerPub.signPk, boxPk: peerPub.boxPk });
    var b = await Xnet.model.roomBundle(room.id);
    Xnet.net.publishMeta(b.room || { id: room.id, name: room.name, createdAt: Date.now() });
    Xnet.net.addMember(room.id, Xnet.model.selfMember());
    Xnet.net.addMember(room.id, { signPk: peerPub.signPk, boxPk: peerPub.boxPk, name: 'peer-' + shortPub(peerPub.signPk) });
    watchRoomMembers(room.id, b.secret || room.secret, (b.membership && b.membership.evictHorizonTs) || 0);
    if (state.view === 'list') showList();
  }

  // Subscribe a room's members and auto-introduce (mesh-signaled, no QR) to any we aren't linked to.
  var membersWatched = {};
  function watchRoomMembers(roomId, secret, horizon) {
    Xnet.net.ensureRoom(roomId, secret, function () { return horizon || 0; });
    if (membersWatched[roomId]) return; membersWatched[roomId] = true;
    Xnet.net.onMembers(roomId, function (m) { tryIntroduce(m); });
  }

  // ============================ settings ============================
  async function showSettings() {
    state.view = 'settings';
    var id = Xnet.model.getIdentity(), s = Xnet.model.getSettings();
    var wrap = el('div', { class: 'view' });
    wrap.appendChild(el('div', { class: 'rowbar' }, [el('button', { class: 'mini', text: '←', onclick: showList }), el('h2', { text: 'Settings' })]));

    var nameInput = el('input', { type: 'text', value: id.displayName });
    wrap.appendChild(sec('Identity', [
      field('Display name', el('div', { class: 'inline' }, [nameInput, el('button', { class: 'secondary', text: 'Save', onclick: async function () { await Xnet.model.setDisplayName(nameInput.value); $('#who').textContent = Xnet.model.getIdentity().displayName; flash('Saved'); } })])),
      field('Public key', el('code', { class: 'wrap', text: id.signPk }))
    ]));

    // connectivity
    var stunArea = el('textarea', { rows: '4', placeholder: 'one stun: URL per line (blank = defaults)' });
    stunArea.value = (s.stun && s.stun.length ? s.stun : Xnet.signaling.DEFAULT_STUN).join('\n');
    var lanChk = el('input', { type: 'checkbox' }); if (s.lanOnly) lanChk.checked = true;
    var turnUrl = el('input', { type: 'text', placeholder: 'turn:host:3478 (optional)', value: (s.turn && s.turn.url) || '' });
    var turnUser = el('input', { type: 'text', placeholder: 'username', value: (s.turn && s.turn.username) || '' });
    var turnCred = el('input', { type: 'text', placeholder: 'credential', value: (s.turn && s.turn.credential) || '' });
    wrap.appendChild(sec('Connectivity (STUN is the only server; TURN opt-in)', [
      field('STUN servers', stunArea),
      field('', el('label', { class: 'inline' }, [lanChk, el('span', { text: ' LAN-only / no STUN (same-network, zero IP leak)' })])),
      field('TURN (optional, sees traffic)', el('div', { class: 'inline' }, [turnUrl, turnUser, turnCred])),
      el('button', { text: 'Save connectivity', onclick: async function () {
        var stun = stunArea.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
        var turn = turnUrl.value.trim() ? { url: turnUrl.value.trim(), username: turnUser.value.trim(), credential: turnCred.value.trim() } : null;
        await Xnet.model.updateSettings({ stun: stun, lanOnly: lanChk.checked, turn: turn }); flash('Saved');
      } })
    ]));

    // storage + clone
    var su = el('div', { class: 'muted small', text: '…' });
    wrap.appendChild(sec('Storage', [field('Mode', el('span', { text: state.mode === 'persistent' ? 'persistent (durable)' : 'ephemeral (nothing saved)' })), field('Usage', su)]));
    if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function (e) { su.textContent = e && e.quota ? (Math.round((e.usage || 0) / 1048576) + ' MB / ' + Math.round((e.quota || 0) / 1048576) + ' MB') : 'n/a'; });
    var copyBtn = el('button', { text: 'Copy install link (data: URL)', disabled: 'true' });
    var dlBtn = el('button', { class: 'secondary', text: 'Download xnet.html', disabled: 'true' });
    var note = el('div', { class: 'muted small' });
    wrap.appendChild(sec('Spread / Clone', [el('div', { class: 'inline' }, [copyBtn, dlBtn]), note]));
    wireClone(copyBtn, dlBtn, note);

    setView(wrap);
    state.rerender = function () {};
  }
  function sec(t, kids) { return el('section', {}, [el('h3', { text: t })].concat(kids)); }
  function field(label, node) { return el('div', { class: 'field' }, [label ? el('div', { class: 'field-label', text: label }) : null, node]); }
  function flash(t) { var b = $('#flash'); if (b) { b.textContent = t; b.style.opacity = 1; setTimeout(function () { b.style.opacity = 0; }, 1200); } }

  // ============================ modal + QR + scan helpers ============================
  function openModal(title, body) {
    var close = el('button', { class: 'mini', text: '✕', onclick: function () { overlay.remove(); } });
    var card = el('div', { class: 'modal' }, [el('div', { class: 'rowbar' }, [el('h2', { text: title }), el('span', { class: 'flex' }), close]), body]);
    var overlay = el('div', { class: 'overlay', onclick: function (e) { if (e.target === overlay) overlay.remove(); } }, [card]);
    document.body.appendChild(overlay);
    return overlay;
  }
  function qrImg(text) {
    try { return el('img', { class: 'qr', src: Xnet.qr.toDataURL(text, { cell: 4, margin: 4 }), alt: 'QR', title: 'Scan with your phone camera to read the invite text' }); }
    catch (e) { return el('div', { class: 'muted small', text: '(invite too long to show as a QR — use copy/file)' }); }
  }
  // A block that PRESENTS an invite: QR (optional native-scan) + copyable text + downloadable file.
  function inviteBlock(text) {
    var ta = el('textarea', { rows: '4', readonly: 'true' }); ta.value = text;
    var copy = el('button', { class: 'secondary', text: 'Copy', onclick: function () {
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(function () { copy.textContent = 'Copied ✓'; setTimeout(function () { copy.textContent = 'Copy'; }, 1500); })
        .catch(function () { ta.focus(); ta.select(); });
    } });
    var dl = el('button', { class: 'secondary', text: 'Download .txt', onclick: function () {
      var u = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      var a = el('a', { href: u, download: 'xnet-invite.txt' }); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 3000);
    } });
    return el('div', {}, [qrImg(text), ta, el('div', { class: 'inline' }, [copy, dl])]);
  }
  // A block that RECEIVES an invite: paste into a textarea or upload a .txt, then act on it.
  function receiveBlock(label, cb) {
    var ta = el('textarea', { rows: '4', placeholder: 'Paste the ' + label + ' text here…' });
    var file = el('input', { type: 'file', accept: '.txt,text/plain' });
    var status = el('div', { class: 'muted small' });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0]; if (!f) return;
      var r = new FileReader(); r.onload = function () { ta.value = String(r.result || '').trim(); status.textContent = 'Loaded file ✓'; }; r.readAsText(f);
    });
    var go = el('button', { text: 'Connect' });
    go.addEventListener('click', async function () {
      var t = ta.value.trim(); if (!t) { status.textContent = 'Paste or upload the ' + label + ' first.'; return; }
      go.disabled = true; status.textContent = 'Connecting…'; status.className = 'muted small';   // prevent double-submit
      try { await cb(t, status); }                                  // success status set by cb
      catch (e) { status.textContent = 'Failed: ' + (e.message || e); status.className = 'err'; go.disabled = false; }
    });
    return el('div', {}, [ta, el('div', { class: 'inline' }, [el('label', { class: 'filebtn' }, [el('span', { text: '📄 Upload .txt' }), file]), go]), status]);
  }
  function toBase64Utf8(str) { var b = new TextEncoder().encode(str), s = '', CH = 0x8000; for (var i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH)); return btoa(s); }
  function wireClone(copyBtn, dlBtn, note) {
    var loaderHtml = window.__XNET_LOADER_HTML__;
    if (typeof loaderHtml !== 'string') { note.innerHTML = 'Run the built <code>dist/xnet.html</code> to enable cloning.'; return; }
    var dataUrl = 'data:text/html;base64,' + toBase64Utf8(loaderHtml);
    note.innerHTML = 'Data-free clone. Installer ≈ <code>' + (dataUrl.length / 1024).toFixed(1) + ' KB</code>. data: URL works on desktop; on phones share the file or a hosted link.';
    copyBtn.removeAttribute('disabled'); dlBtn.removeAttribute('disabled');
    copyBtn.onclick = function () { (navigator.clipboard ? navigator.clipboard.writeText(dataUrl) : Promise.reject()).then(function () { copyBtn.textContent = 'Copied ✓'; }).catch(function () { window.prompt('Copy:', dataUrl); }); };
    dlBtn.onclick = function () { var u = URL.createObjectURL(new Blob([loaderHtml], { type: 'text/html' })); var a = el('a', { href: u, download: 'xnet.html' }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 4000); };
  }

  // ============================ boot ============================
  async function boot() {
    var proto = location.protocol;
    var modeLabel = (proto === 'https:' || proto === 'http:') ? 'hosted' : proto === 'file:' ? 'file://' : proto === 'data:' ? 'data:' : proto;
    var store = await Xnet.store.open();
    var info = await Xnet.model.init(store);
    state.mode = info.mode;
    Xnet.net.start(window.Gun);
    Xnet.net.setOnChange(function () { updatePeers(); state.rerender(); });

    // meet-once mesh: negotiate new links over the gun graph, no QR (DESIGN §5.3)
    connector = Xnet.signal.createConnector({
      gun: Xnet.net.gun(), identity: info.identity, RTCPeerConnection: window.RTCPeerConnection,
      iceServers: function () { return Xnet.signaling.iceServers(Xnet.model.getSettings()); },
      onLink: function (link, peer) { addPeerLink(link, peer); },
      isConnected: function (pk) { return !!connectedPeers[pk]; }
    });
    connector.watch();

    $('#mode').textContent = modeLabel + ' · ' + (info.mode === 'persistent' ? 'saved' : 'ephemeral');
    $('#who').textContent = info.identity.displayName;
    $('#nav-settings').onclick = showSettings;
    $('#brand').onclick = showList;

    // subscribe + (re)publish every joined room; member subscriptions drive auto-introduction
    var rooms = await Xnet.model.joinedRooms();
    for (var i = 0; i < rooms.length; i++) {
      var b = await Xnet.model.roomBundle(rooms[i].room.id);
      Xnet.net.publishMeta(b.room); Xnet.net.addMember(b.room.id, Xnet.model.selfMember());
      watchRoomMembers(b.room.id, b.secret, b.membership.evictHorizonTs);
    }
    showList();
    setInterval(updatePeers, 2000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
