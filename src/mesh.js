/* Xnet — gun mesh adapter. Bridges gun's wire protocol onto arbitrary duplex "links"
   (a stub transport here in Phase 3; real RTCDataChannels in Phase 4). gun is created with
   an EMPTY peer list so it never touches a third-party relay (DESIGN §0, §5.5, D4). */
(function (root) {
  'use strict';
  var Xnet = root.Xnet = root.Xnet || {};

  // schedule(fn): run async (breaks recursion, mimics a network hop).
  var schedule = function (fn) { setTimeout(fn, 0); };

  // A "link" is any object with: send(rawString) and an assignable onmessage(rawString) handler
  // (optionally onclose). RTCDataChannel and our stub both fit this shape.
  function create(Gun, opts) {
    opts = opts || {};
    // peers:[] = never contact a relay (DESIGN §0). multicast/axe:false = no LAN/relay auto-discovery.
    // We do NOT disable storage: gun needs a store adapter to retain puts and fire subscriptions
    // (browser → localStorage/IndexedDB; tests → radisk). Swapping in our IndexedDB-backed adapter
    // with eviction (DESIGN §7.1) is a follow-up when the UI is wired to the mesh.
    var gun = Gun(Object.assign(
      { peers: [], multicast: false, axe: false },
      opts.gun || {}
    ));
    var links = new Set();

    // Single outbound hook: broadcast every gun wire message to all connected links.
    // Loops are bounded by gun's own dedup ('#' ids), so we don't need origin tagging.
    gun.on('out', function (msg) {
      this.to.next(msg);                       // keep gun's internal chain intact
      if (!links.size) return;
      var raw = JSON.stringify(msg);
      links.forEach(function (l) { try { l.send(raw); } catch (e) {} });
    });

    function addLink(link) {
      links.add(link);
      link.onmessage = function (raw) {
        var msg; try { msg = JSON.parse(raw); } catch (e) { return; }
        gun.on('in', msg);
      };
      var prevClose = link.onclose;
      link.onclose = function () { links.delete(link); if (typeof prevClose === 'function') prevClose(); };
      return { remove: function () { links.delete(link); } };
    }

    return { gun: gun, addLink: addLink, links: links, peerCount: function () { return links.size; } };
  }

  // In-process stub transport: two duplex channels wired to each other (for tests / same-page).
  function stubPair() {
    var a = { send: function (m) { schedule(function () { if (b.onmessage) b.onmessage(m); }); }, onmessage: null, onclose: null };
    var b = { send: function (m) { schedule(function () { if (a.onmessage) a.onmessage(m); }); }, onmessage: null, onclose: null };
    return [a, b];
  }

  Xnet.mesh = { create: create, stubPair: stubPair };
})(typeof window !== 'undefined' ? window : globalThis);
