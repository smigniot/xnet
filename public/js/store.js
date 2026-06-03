// store.js
// --------
// The client's OWN durable store, on IndexedDB. This is deliberately separate
// from Gun: Gun is used purely as an in-memory transport/sync bus, and THIS is
// where messages and private state actually live on the device.
//
// Why owned instead of letting Gun persist? Because eviction must be a *local
// forget* that never propagates. Deleting a node from Gun's synced graph is a
// tombstone that replicates and would delete the message from every peer. By
// keeping the durable copy in our own IndexedDB, we can drop the oldest records
// locally without the network ever knowing — exactly the guarantee we want.
//
// Two object stores:
//   messages: { id, scope, ts, from, ct, kind }   (ct = ciphertext; never plaintext at rest)
//   kv:       { k, v }                              (session pair, contacts, rooms, reads, horizons)

const DB_NAME = 'xnet';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('messages')) {
        const ms = db.createObjectStore('messages', { keyPath: 'id' });
        ms.createIndex('ts', 'ts');
        ms.createIndex('scope', 'scope');
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function reqP(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function osFor(name, mode) {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

// --- messages --------------------------------------------------------------

export async function putMessage(m) {
  const os = await osFor('messages', 'readwrite');
  return reqP(os.put(m));
}

export async function messagesForScope(scope) {
  const os = await osFor('messages', 'readonly');
  const rows = await reqP(os.index('scope').getAll(IDBKeyRange.only(scope)));
  return rows.sort((a, b) => a.ts - b.ts);
}

// Oldest `limit` messages across ALL scopes (ascending by ts) — eviction order.
export async function oldest(limit) {
  const os = await osFor('messages', 'readonly');
  const out = [];
  return new Promise((resolve, reject) => {
    const cursor = os.index('ts').openCursor();
    cursor.onsuccess = () => {
      const cur = cursor.result;
      if (cur && out.length < limit) { out.push(cur.value); cur.continue(); }
      else resolve(out);
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

export async function deleteMessages(ids) {
  const os = await osFor('messages', 'readwrite');
  await Promise.all(ids.map((id) => reqP(os.delete(id))));
}

export async function count() {
  const os = await osFor('messages', 'readonly');
  return reqP(os.count());
}

// --- key/value -------------------------------------------------------------

export async function kvGet(k) {
  const os = await osFor('kv', 'readonly');
  const row = await reqP(os.get(k));
  return row ? row.v : undefined;
}

export async function kvSet(k, v) {
  const os = await osFor('kv', 'readwrite');
  return reqP(os.put({ k, v }));
}

export async function kvDel(k) {
  const os = await osFor('kv', 'readwrite');
  return reqP(os.delete(k));
}

// --- storage metering ------------------------------------------------------

export async function estimate() {
  if (navigator.storage && navigator.storage.estimate) {
    try { return await navigator.storage.estimate(); } catch { return null; }
  }
  return null;
}

// Ask the browser to keep our data durable (don't auto-evict under pressure).
export async function persist() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch { return false; }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pressure-based eviction policy — pure and testable.
//
// `io` is an adapter the caller wires to real storage:
//   io.estimate() -> { usage, quota } | null
//   io.count()    -> total message records
//   io.oldest(n)  -> [ {id, scope, ts, ...}, ... ]  (ascending by ts)
//   io.remove(records) -> drop those records (store + memory)
//   io.setHorizon(scope, ts) -> remember "evicted below ts" for this scope
//
// Goal: free space when usage >= highMark*quota, down toward lowMark*quota,
// dropping OLDEST-first while keeping as much (newest) as possible.
//
// Why proportional-by-count instead of "loop deleting until estimate drops":
// navigator.storage.estimate() is approximate and updates lazily, so a tight
// estimate-driven loop either over-evicts (wipes everything) or never
// converges. Instead, each pass estimates how many messages to drop from the
// average size (bytes_to_free / avg_message_size) and removes exactly that
// many oldest. Bounded passes handle size variance; if the estimate doesn't
// move after a pass (lag), we stop and let the next scheduled run continue.
// ---------------------------------------------------------------------------
export async function runEviction(io, opts = {}) {
  const highMark = opts.highMark ?? 0.9;
  const lowMark = opts.lowMark ?? 0.75;
  const maxPasses = opts.maxPasses ?? 8;

  let est = await io.estimate();
  if (!est || !est.quota) return { evicted: 0, reason: 'no-estimate' };
  if (est.usage < highMark * est.quota) return { evicted: 0, reason: 'below-high' };

  const low = lowMark * est.quota;
  const horizons = {};
  let evicted = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    if (!est || !est.quota || est.usage <= low) break;
    const total = await io.count();
    if (!total) break;
    const avg = est.usage / total;                       // bytes per message (approx)
    const need = est.usage - low;                        // bytes to free
    const toEvict = Math.min(total, Math.max(1, Math.ceil(need / avg)));
    const records = await io.oldest(toEvict);
    if (!records.length) break;
    for (const r of records) horizons[r.scope] = Math.max(horizons[r.scope] || 0, r.ts);
    await io.remove(records);
    evicted += records.length;

    const prev = est.usage;
    est = await io.estimate();
    if (!est || !est.quota) break;
    if (est.usage >= prev) break; // estimate didn't reflect the deletes (lag) — stop, resume next sweep
  }

  for (const [scope, ts] of Object.entries(horizons)) await io.setHorizon(scope, ts);
  return { evicted, reason: 'pressure', horizons };
}
