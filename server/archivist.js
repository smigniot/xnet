// archivist.js
// ------------
// The server-side retention layer + janitor. Runs as its OWN process (forked
// by server.js) and connects to the relay over the wire as a normal peer.
//
// Why a separate process and not the relay's own Gun instance?
//  * The relay forwards messages at the mesh layer and never ingests them into
//    its own graph/storage — a subscription on the relay instance captures
//    nothing (verified). A separate peer that subscribes DOES receive them.
//  * Two Gun instances inside one process share mesh/dedup state and step on
//    each other, so the archivist also can't live in the relay process. A
//    forked child with its own event loop is the reliable shape.
//
// What it does:
//  * Subscribes to every message node and appends each to an ndjson log we own.
//  * Re-injects survivors on boot so reconnecting clients can sync missed
//    history (store-and-forward across restarts).
//  * Runs a janitor that FORGETS old messages by deleting from OUR log only —
//    never a Gun graph delete, so a prune can never erase a client's copy.
//
// Durability handoff: the server is holder-of-last-resort for recent messages
// (within the grace window). Clients are the permanent archive; after grace the
// server may forget, and the message survives on participants' devices.

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Gun = require('gun');
require('gun/sea.js');
const SEA = Gun.SEA;

export function startArchivist(opts = {}) {
  const dir = opts.dir;
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, 'archive.ndjson');

  const graceMs = opts.graceMs ?? 60 * 24 * 3600 * 1000; // 60 days
  const maxRecords = opts.maxRecords ?? 100000;          // size backstop
  const janitorMs = opts.janitorMs ?? 3600 * 1000;       // hourly

  const now = () => Date.now();
  const idOf = (r) => `${r.kind}/${r.scope}/${r.key}`;

  const archive = new Map();          // recordId -> {kind, scope, key, ts, from, c}
  const acks = new Map();             // scope -> Map(readerPub -> upTo)

  // Our own peer connection to the relay (memory-only; the ndjson log is our
  // durable copy, not Gun's store).
  const gun = Gun({ peers: [opts.peer], radisk: false, localStorage: false, multicast: false });

  // --- persistence (append log, compacted on prune) ---
  function append(rec) { appendFileSync(logPath, JSON.stringify(rec) + '\n'); }
  function compact() {
    const tmp = logPath + '.tmp';
    const body = [...archive.values()].map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(tmp, archive.size ? body + '\n' : '');
    renameSync(tmp, logPath);
  }
  function load() {
    if (!existsSync(logPath)) return;
    for (const line of readFileSync(logPath, 'utf8').split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); archive.set(idOf(r), r); } catch { /* skip */ }
    }
    compact();
  }

  // --- capture: subscribe to every message node, live ---
  function capture(kind, scope, key, m) {
    const rec = { kind, scope, key, ts: m.ts || 0, from: m.from || null, c: m.c };
    const id = idOf(rec);
    if (archive.has(id)) return;
    archive.set(id, rec);
    append(rec);
  }
  const DBG = process.env.XNET_ARCH_DEBUG === '1';
  function watch(kind) {
    gun.get('xnet').get(kind).map().on((_v, scope) => {
      if (DBG) console.error('[arch] scope seen:', kind, scope);
      gun.get('xnet').get(kind).get(scope).get('messages').map().on((m, key) => {
        if (DBG) console.error('[arch] msg seen:', kind, scope, key, m && m.c ? 'c-ok' : m);
        if (m && m.c && key) capture(kind, scope, key, m);
      });
    });
  }

  // --- acks: read signed reader watermarks (verify before trusting) ---
  function watchAcks() {
    gun.get('xnet').get('acks').map().on((_v, scope) => {
      gun.get('xnet').get('acks').get(scope).map().on(async (rec, pub) => {
        if (!rec || rec.upTo == null || !rec.w) return;
        const claim = await SEA.verify(rec.w, pub).catch(() => null);
        if (claim && claim.scope === scope && claim.pub === pub && typeof claim.upTo === 'number') {
          let m = acks.get(scope);
          if (!m) { m = new Map(); acks.set(scope, m); }
          m.set(pub, Math.max(m.get(pub) || 0, claim.upTo));
        }
      });
    });
  }

  // Delivered to all readers who have acked this scope. Only used to make the
  // size backstop SAFER (prefer dropping delivered messages), never to prune
  // more aggressively than the grace TTL allows.
  function ackedByAll(rec) {
    const m = acks.get(rec.scope);
    if (!m || m.size === 0) return false;
    for (const upTo of m.values()) if (upTo < rec.ts) return false;
    return true;
  }

  // --- the janitor: forget, safely ---
  function janitor() {
    const cutoff = now() - graceMs;
    let removed = 0;

    // 1) Grace TTL — the safety floor.
    for (const [id, rec] of archive) {
      if (rec.ts < cutoff) { archive.delete(id); removed++; }
    }

    // 2) Size backstop — drop oldest-first, delivered-first, if still over cap.
    if (archive.size > maxRecords) {
      const sorted = [...archive.values()].sort((a, b) => {
        const aa = ackedByAll(a) ? 0 : 1, bb = ackedByAll(b) ? 0 : 1;
        return aa - bb || a.ts - b.ts;
      });
      let over = archive.size - maxRecords;
      for (const rec of sorted) {
        if (over <= 0) break;
        archive.delete(idOf(rec)); removed++; over--;
      }
    }

    if (removed) compact();
    return { removed, retained: archive.size };
  }

  // --- boot ---
  load();
  for (const rec of archive.values()) {
    gun.get('xnet').get(rec.kind).get(rec.scope).get('messages').get(rec.key)
      .put({ c: rec.c, from: rec.from, ts: rec.ts });
  }
  watch('dm');
  watch('rooms');
  watchAcks();
  const timer = setInterval(janitor, janitorMs);

  console.log(`  Archivist: grace=${Math.round(graceMs / 86400000)}d cap=${maxRecords} sweep=${Math.round(janitorMs / 1000)}s loaded=${archive.size}`);

  return { janitor, stats: () => ({ retained: archive.size, scopesAcked: acks.size }), stop: () => clearInterval(timer), _archive: archive };
}

// --- standalone entry (forked by server.js) ---
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const env = process.env;
  startArchivist({
    peer: env.XNET_ARCH_PEER,
    dir: env.XNET_ARCH_DIR || join(__dirname, '..', 'data', 'archive'),
    graceMs: env.XNET_GRACE_MS ? Number(env.XNET_GRACE_MS) : undefined,
    maxRecords: env.XNET_MAX_RECORDS ? Number(env.XNET_MAX_RECORDS) : undefined,
    janitorMs: env.XNET_JANITOR_MS ? Number(env.XNET_JANITOR_MS) : undefined,
  });
  process.on('SIGTERM', () => process.exit(0));
}
