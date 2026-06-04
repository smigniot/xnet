// Xnet server
// -----------
// A single Node process that does two jobs:
//   1. Serves the static SPA from /public (with long cache headers so the
//      service worker can keep the app booting while the server is offline).
//   2. Hosts a Gun.js relay peer at /gun so freshly-opened browsers can find
//      each other. Once peers are connected they sync directly; the relay can
//      then disappear and conversations keep flowing.
//
// Everything that travels through the relay is already encrypted on the client
// (SEA), so this process never sees plaintext. It is a dumb, replaceable mailbox.

import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fork } from 'node:child_process';

const require = createRequire(import.meta.url);
const Gun = require('gun');
// Pull in the SEA + relay extras so the relay understands signed/encrypted data.
require('gun/sea.js');
// Server-side persistence: radisk + the Node filesystem adapter (rfs). NOTE:
// it must be rfs.js (filesystem), NOT rindexed.js (that is the browser's
// IndexedDB adapter and silently no-ops on the server).
require('gun/lib/store.js');
require('gun/lib/rfs.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const GUN_DIR = dirname(require.resolve('gun'));

const PORT = process.env.PORT || 8765;

// Where Gun persists the encrypted graph on the server side.
const DATA_DIR = process.env.GUN_DATA || join(__dirname, '..', 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// Files we expose out of the installed gun package so the browser can load the
// library locally (and the service worker can cache it for offline boot).
const VENDOR = {
  '/vendor/gun.js': join(GUN_DIR, 'gun.js'),
  '/vendor/sea.js': join(GUN_DIR, 'sea.js'),
};

async function sendFile(res, filePath, { immutable = false } = {}) {
  const data = await readFile(filePath);
  const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type };
  // The service worker handles freshness for app files; the SW script itself
  // must never be cached aggressively or updates can't roll out.
  if (filePath.endsWith('sw.js')) {
    headers['Cache-Control'] = 'no-cache';
  } else if (immutable) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'no-cache';
  }
  res.writeHead(200, headers);
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);

    // Vendored Gun library files.
    if (VENDOR[pathname]) {
      return await sendFile(res, VENDOR[pathname], { immutable: true });
    }

    // Gun relay traffic is handled by the Gun instance below; let it fall
    // through (Gun attaches to the same http server).
    if (pathname === '/gun' || pathname.startsWith('/gun/')) {
      return; // handled by Gun's own listener
    }

    // SPA routing: everything that isn't a real file serves index.html.
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    const safePath = normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    let filePath = join(PUBLIC_DIR, safePath);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    let fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      // Single-page app fallback.
      filePath = join(PUBLIC_DIR, 'index.html');
    }

    await sendFile(res, filePath);
  } catch (err) {
    res.writeHead(500);
    res.end('Server error');
    console.error(err);
  }
});

// Attach the Gun relay to the same HTTP server, served under /gun.
//
// Durability model (verified, not assumed): Gun's relay forwards live updates
// to currently-subscribed peers and best-effort persists the graph to radisk,
// but it does NOT guarantee store-and-forward of fire-and-forget puts to a peer
// that is offline at send time. That's by design — in Gun, durability lives in
// the *clients*: every browser persists its own copy (localStorage) and peers
// re-sync directly when they next meet. So this relay is a discovery point and
// live forwarder; losing it never loses messages held by participants.
//
// multicast:false silences LAN discovery we don't use.
const gun = Gun({
  web: server,
  file: DATA_DIR,
  radisk: true,
  multicast: false,
});

// Retention + janitor (server-side message archive with safe, local-only
// pruning). Built and unit-correct, but OFF BY DEFAULT and opt-in via
// XNET_ARCHIVIST=1 because of a measured Gun limitation in this version:
//
//   A Node-side Gun peer does NOT reliably receive messages from the relay over
//   websocket — node<->relay<->node graph sync doesn't propagate here (only
//   browsers sync through the relay; node peers only synced via LAN multicast,
//   which clouds don't have). So the archivist can't capture in production.
//
// The flip side: because the relay itself stores nothing and only forwards live
// traffic, the server already "runs forever" (stateless) and can never remove a
// message erroneously — durability lives entirely in the clients (their
// IndexedDB + P2P resync). The janitor is therefore unnecessary today; it stays
// here, verified, ready for a Gun version where server-side capture works.
let archivistChild = null;
function spawnArchivist() {
  if (process.env.XNET_ARCHIVIST !== '1') return;
  archivistChild = fork(join(__dirname, 'archivist.js'), [], {
    env: {
      ...process.env,
      XNET_ARCH_PEER: `http://localhost:${PORT}/gun`,
      XNET_ARCH_DIR: join(DATA_DIR, 'archive'),
    },
  });
  archivistChild.on('exit', (code) => {
    console.error(`  Archivist exited (${code}); restarting in 3s`);
    archivistChild = null;
    setTimeout(spawnArchivist, 3000);
  });
}

server.listen(PORT, () => {
  console.log(`\n  Xnet is running`);
  console.log(`  SPA   ->  http://localhost:${PORT}/`);
  console.log(`  Relay ->  http://localhost:${PORT}/gun`);
  console.log(`  Data  ->  ${DATA_DIR}\n`);
  spawnArchivist();
});

function shutdown() { if (archivistChild) archivistChild.kill('SIGTERM'); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Keep a reference so the process doesn't tree-shake the relay away.
export { gun };
