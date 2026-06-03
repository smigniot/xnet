/* Xnet — persistence (IndexedDB when available, in-memory fallback) + storage metering.
   Uniform async API used by model.js. No business logic here. DESIGN §6.2, §7. */
(function (root) {
  'use strict';
  var Xnet = root.Xnet = root.Xnet || {};

  var STORES = {
    kv:          { keyPath: 'k' },                              // identity, settings
    contacts:    { keyPath: 'pub' },
    rooms:       { keyPath: 'id' },
    roomSecrets: { keyPath: 'roomId' },
    membership:  { keyPath: 'roomId' },
    messages:    { keyPath: 'id', indexes: [['roomTs', ['roomId', 'ts']], ['ts', 'ts']] }
  };
  var DB_NAME = 'xnet', DB_VER = 1;
  var TS_MAX = Number.MAX_SAFE_INTEGER;

  function storageAvailable() {
    try {
      var k = '__xnet_probe__';
      localStorage.setItem(k, '1'); localStorage.removeItem(k);
      return typeof indexedDB !== 'undefined' && !!indexedDB;
    } catch (e) { return false; }
  }

  // ---------- IndexedDB backend ----------
  function openIDB() {
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        Object.keys(STORES).forEach(function (name) {
          if (db.objectStoreNames.contains(name)) return;
          var os = db.createObjectStore(name, { keyPath: STORES[name].keyPath });
          (STORES[name].indexes || []).forEach(function (ix) { os.createIndex(ix[0], ix[1]); });
        });
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }
  function idbBackend(db) {
    function os(store, mode) { return db.transaction(store, mode).objectStore(store); }
    function p(req) { return new Promise(function (res, rej) { req.onsuccess = function () { res(req.result); }; req.onerror = function () { rej(req.error); }; }); }
    return {
      mode: 'persistent',
      get: function (s, k) { return p(os(s, 'readonly').get(k)); },
      put: function (s, o) { return p(os(s, 'readwrite').put(o)); },
      del: function (s, k) { return p(os(s, 'readwrite').delete(k)); },
      all: function (s) { return p(os(s, 'readonly').getAll()); },
      count: function (s) { return p(os(s, 'readonly').count()); },
      messagesByRoom: function (roomId) {
        return p(os('messages', 'readonly').index('roomTs').getAll(IDBKeyRange.bound([roomId, 0], [roomId, TS_MAX])));
      },
      messagesOldest: function (limit) {
        return new Promise(function (res, rej) {
          var out = [], cur = os('messages', 'readonly').index('ts').openCursor();
          cur.onsuccess = function () { var c = cur.result; if (c && out.length < limit) { out.push(c.value); c.continue(); } else res(out); };
          cur.onerror = function () { rej(cur.error); };
        });
      },
      estimate: function () { return (navigator.storage && navigator.storage.estimate) ? navigator.storage.estimate() : Promise.resolve(null); },
      persist: function () { return (navigator.storage && navigator.storage.persist) ? navigator.storage.persist() : Promise.resolve(false); }
    };
  }

  // ---------- in-memory backend ----------
  function memBackend() {
    var m = {}; Object.keys(STORES).forEach(function (s) { m[s] = new Map(); });
    var kp = function (s) { return STORES[s].keyPath; };
    var msgs = function () { return Array.from(m.messages.values()); };
    return {
      mode: 'ephemeral',
      get: function (s, k) { return Promise.resolve(m[s].get(k)); },
      put: function (s, o) { m[s].set(o[kp(s)], o); return Promise.resolve(); },
      del: function (s, k) { m[s].delete(k); return Promise.resolve(); },
      all: function (s) { return Promise.resolve(Array.from(m[s].values())); },
      count: function (s) { return Promise.resolve(m[s].size); },
      messagesByRoom: function (roomId) { return Promise.resolve(msgs().filter(function (x) { return x.roomId === roomId; }).sort(function (a, b) { return a.ts - b.ts; })); },
      messagesOldest: function (limit) { return Promise.resolve(msgs().sort(function (a, b) { return a.ts - b.ts; }).slice(0, limit)); },
      estimate: function () { return Promise.resolve(null); },   // no quota pressure model in memory
      persist: function () { return Promise.resolve(false); }
    };
  }

  Xnet.store = {
    storageAvailable: storageAvailable,
    open: async function () {
      if (storageAvailable()) {
        try { return idbBackend(await openIDB()); } catch (e) { /* fall back to memory */ }
      }
      return memBackend();
    },
    _memBackend: memBackend   // exposed for tests
  };
})(typeof window !== 'undefined' ? window : globalThis);
