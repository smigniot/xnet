/* Xnet — first-contact signaling (DESIGN §2.2, §2.3, §5.1).
   QR invite = compressed {sdp, pubkeys, room}. Pure pack/unpack (Node-testable) + browser-only
   WebRTC orchestration. STUN is the only server (TURN opt-in); peers learn each other's pubkeys
   and (for the offer) the shared room at first contact. */
(function (root) {
  'use strict';
  var Xnet = root.Xnet = root.Xnet || {};
  var C = function () { return Xnet.codec; };

  // ---- invite packing (kept terse to shrink the QR) ----
  function packOffer(sdp, identity, room) {
    return C().pack({ v: 1, t: 'o', sdp: sdp, pub: { s: identity.signPk, b: identity.boxPk }, room: { i: room.id, k: room.secret, n: room.name } });
  }
  function packAnswer(sdp, identity) {
    return C().pack({ v: 1, t: 'a', sdp: sdp, pub: { s: identity.signPk, b: identity.boxPk } });
  }
  async function unpack(str) {
    var o = await C().unpack(str);
    var out = { v: o.v, type: o.t === 'o' ? 'offer' : 'answer', sdp: o.sdp, pub: { signPk: o.pub.s, boxPk: o.pub.b } };
    if (o.room) out.room = { id: o.room.i, secret: o.room.k, name: o.room.n };
    return out;
  }

  // ---- ICE configuration (DESIGN §2.3) ----
  var DEFAULT_STUN = [
    'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302',
    'stun:stun.cloudflare.com:3478', 'stun:global.stun.twilio.com:3478',
    'stun:stun.nextcloud.com:443'
  ];
  function iceServers(settings) {
    settings = settings || {};
    if (settings.lanOnly) return [];                       // no-STUN: same-network only, zero IP leak
    var urls = (settings.stun && settings.stun.length) ? settings.stun : DEFAULT_STUN;
    var servers = urls.map(function (u) { return { urls: u }; });
    if (settings.turn && settings.turn.url) servers.push({ urls: settings.turn.url, username: settings.turn.username || '', credential: settings.turn.credential || '' });
    return servers;
  }

  // ---- WebRTC (browser only) ----
  function gatherComplete(pc, timeoutMs) {
    return new Promise(function (res) {
      if (pc.iceGatheringState === 'complete') return res();
      var done = false, finish = function () { if (!done) { done = true; clearTimeout(to); res(); } };
      var to = setTimeout(finish, timeoutMs || 2500);      // non-trickle, but don't wait forever
      pc.addEventListener('icegatheringstatechange', function () { if (pc.iceGatheringState === 'complete') finish(); });
      pc.addEventListener('icecandidate', function (e) { if (!e.candidate) finish(); });
    });
  }

  // Log ICE/connection transitions to the console — invaluable for diagnosing NAT failures.
  function diag(pc, tag) {
    pc.addEventListener('iceconnectionstatechange', function () { try { console.log('[xnet ' + tag + ' ice]', pc.iceConnectionState); } catch (e) {} });
    pc.addEventListener('connectionstatechange', function () { try { console.log('[xnet ' + tag + ' conn]', pc.connectionState); } catch (e) {} });
  }

  // Alice: build an offer invite. Returns { pc, dc, invite }.
  async function createOffer(settings, identity, room) {
    var pc = new RTCPeerConnection({ iceServers: iceServers(settings) });
    diag(pc, 'offerer');
    var dc = pc.createDataChannel('xnet', { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    await gatherComplete(pc);
    return { pc: pc, dc: dc, invite: await packOffer(pc.localDescription.sdp, identity, room) };
  }

  // Bob: accept Alice's offer. Returns { pc, dcPromise, answer, room, peerPub }.
  async function acceptOffer(settings, identity, offerB64) {
    var inv = await unpack(offerB64);
    if (inv.type !== 'offer') throw new Error('that QR is not an offer');
    var pc = new RTCPeerConnection({ iceServers: iceServers(settings) });
    diag(pc, 'answerer');
    var resolveDc, dcPromise = new Promise(function (r) { resolveDc = r; });
    pc.addEventListener('datachannel', function (e) { resolveDc(e.channel); });
    await pc.setRemoteDescription({ type: 'offer', sdp: inv.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gatherComplete(pc);
    return { pc: pc, dcPromise: dcPromise, answer: await packAnswer(pc.localDescription.sdp, identity), room: inv.room, peerPub: inv.pub };
  }

  // Alice: finish with Bob's answer. State-guarded so a double "Connect" can't throw.
  async function finishOffer(pc, answerB64) {
    var inv = await unpack(answerB64);
    if (inv.type !== 'answer') throw new Error('that text is not an answer — paste the answer your friend sent back');
    if (pc.signalingState === 'stable') return { peerPub: inv.pub };              // answer already applied
    if (pc.signalingState !== 'have-local-offer') throw new Error('unexpected connection state: ' + pc.signalingState);
    await pc.setRemoteDescription({ type: 'answer', sdp: inv.sdp });
    return { peerPub: inv.pub };
  }

  // Wrap an RTCDataChannel as a mesh link (matches mesh.addLink's expected shape).
  function channelLink(dc) {
    var link = { send: function (raw) { try { dc.send(raw); } catch (e) {} }, onmessage: null, onclose: null };
    dc.addEventListener('message', function (e) { if (link.onmessage) link.onmessage(e.data); });
    dc.addEventListener('close', function () { if (link.onclose) link.onclose(); });
    return link;
  }
  function whenOpen(dc, timeoutMs) {
    return new Promise(function (res, rej) {
      if (dc.readyState === 'open') return res();
      var to = setTimeout(function () { rej(new Error('the connection did not open (likely a NAT/firewall block — try both devices on the same Wi-Fi, or set a TURN server in Settings)')); }, timeoutMs || 25000);
      dc.addEventListener('open', function () { clearTimeout(to); res(); });
      dc.addEventListener('close', function () { clearTimeout(to); rej(new Error('the connection closed before opening')); });
    });
  }

  Xnet.signaling = {
    packOffer: packOffer, packAnswer: packAnswer, unpack: unpack,
    iceServers: iceServers, DEFAULT_STUN: DEFAULT_STUN, gatherComplete: gatherComplete,
    createOffer: createOffer, acceptOffer: acceptOffer, finishOffer: finishOffer,
    channelLink: channelLink, whenOpen: whenOpen
  };
})(typeof window !== 'undefined' ? window : globalThis);
