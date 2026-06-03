/* Xnet — meet-once mesh signaling (DESIGN §5.3). After first contact, NEW direct WebRTC links
   are negotiated over the gun graph instead of QR: offers/answers are box-encrypted to the
   recipient's key + signed, written to `xnet/signal/<recipientSignPk>`, and ride the existing
   mesh (transitively) to the target. Used for: reconnecting dropped links and introducing
   members who never met by QR — all with no further scan, as long as a mesh path exists. */
(function (root) {
  'use strict';
  var Xnet = root.Xnet = root.Xnet || {};
  var C = function () { return Xnet.crypto; };
  var S = function () { return Xnet.signaling; };

  // ---- signed + boxed signal records (pure, testable) ----
  // Flat fields only: gun flattens nested objects into separate graph nodes, so a nested `from`
  // would arrive as an unresolved link. Keep everything top-level primitive.
  function canon(rec) { return rec.k + '|' + rec.sid + '|' + rec.to + '|' + rec.fs + '|' + rec.fb + '|' + rec.enc + '|' + rec.ts; }
  function makeRecord(kind, sid, identity, toBoxPk, sdp) {
    var rec = { k: kind, sid: sid, to: toBoxPk, fs: identity.signPk, fb: identity.boxPk, enc: C().boxSeal(sdp, toBoxPk, identity.boxSk), ts: Date.now() };
    rec.sig = C().sign(C().enc.strToBytes(canon(rec)), identity.signSk);
    return rec;
  }
  function openRecord(rec, identity) {
    if (!rec || !rec.fs || !rec.fb || !rec.enc || !rec.sig || !rec.sid) return null;
    if (!C().verify(C().enc.strToBytes(canon(rec)), rec.sig, rec.fs)) return null;   // authenticity
    var sdp = C().boxOpen(rec.enc, rec.fb, identity.boxSk);                           // confidentiality
    return sdp == null ? null : { sdp: sdp, fromSignPk: rec.fs, fromBoxPk: rec.fb, kind: rec.k, sid: rec.sid };
  }

  // ---- connector: watch my inbox, negotiate links over gun ----
  // opts: { gun, identity, iceServers(), RTCPeerConnection, onLink(link, peerSignPk), isConnected(peerSignPk) }
  function createConnector(opts) {
    var gun = opts.gun, identity = opts.identity;
    var PC = opts.RTCPeerConnection || root.RTCPeerConnection;
    var inbox = gun.get('xnet').get('signal').get(identity.signPk);
    var processed = {};     // sid:kind seen
    var pending = {};       // sid -> { pc, dc }

    function putTo(toSignPk, rec) { gun.get('xnet').get('signal').get(toSignPk).get(rec.sid + ':' + rec.k).put(rec); }
    function newPC() { return new PC({ iceServers: opts.iceServers ? opts.iceServers() : [] }); }
    function connected(pk) { return opts.isConnected && opts.isConnected(pk); }

    async function handleOffer(o) {
      if (connected(o.fromSignPk)) return;
      var pc = newPC(), resolveDc, dcP = new Promise(function (r) { resolveDc = r; });
      pc.ondatachannel = function (e) { resolveDc(e.channel); };
      await pc.setRemoteDescription({ type: 'offer', sdp: o.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await S().gatherComplete(pc);
      putTo(o.fromSignPk, makeRecord('answer', o.sid, identity, o.fromBoxPk, pc.localDescription.sdp));
      var dc = await dcP; await S().whenOpen(dc);
      opts.onLink(S().channelLink(dc), o.fromSignPk);
    }
    async function handleAnswer(a) {
      var p = pending[a.sid]; if (!p) return; delete pending[a.sid];
      await p.pc.setRemoteDescription({ type: 'answer', sdp: a.sdp });
      await S().whenOpen(p.dc);
      opts.onLink(S().channelLink(p.dc), a.fromSignPk);
    }

    function watch() {
      inbox.map().on(function (rec) {
        if (!rec || !rec.k || !rec.sid) return;
        var tag = rec.sid + ':' + rec.k; if (processed[tag]) return;
        var o = openRecord(rec, identity); if (!o) return;
        processed[tag] = true;
        if (o.fromSignPk === identity.signPk) return;
        (o.kind === 'offer' ? handleOffer : handleAnswer)(o).catch(function () {});
      });
    }

    async function connectTo(peerSignPk, peerBoxPk) {
      if (!peerSignPk || !peerBoxPk || peerSignPk === identity.signPk || connected(peerSignPk)) return;
      var sid = C().uuid(), pc = newPC(), dc = pc.createDataChannel('xnet', { ordered: true });
      pending[sid] = { pc: pc, dc: dc };
      await pc.setLocalDescription(await pc.createOffer());
      await S().gatherComplete(pc);
      putTo(peerSignPk, makeRecord('offer', sid, identity, peerBoxPk, pc.localDescription.sdp));
    }

    return { watch: watch, connectTo: connectTo };
  }

  Xnet.signal = { makeRecord: makeRecord, openRecord: openRecord, createConnector: createConnector };
})(typeof window !== 'undefined' ? window : globalThis);
