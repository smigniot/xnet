// Xnet build pipeline (Phase 1).
//   src/index.html  --inline-->  payload HTML  --gzip+base64-->  embed in loader.html
//   -> dist/xnet.html (the self-decompressing single-file app)
//   -> dist/xnet.dataurl.txt (data:text/html;base64,… — the desktop spread/seed form)
//
// Dependency-free: uses only Node built-ins (fs, zlib, path). Run: `node build.mjs`.
// Decision refs: DESIGN.md §4 (build artifact / self-decompress), §4.5 (self-propagation).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

// Inline local <link rel=stylesheet> and <script src> so the payload is one self-contained file.
// Remote (http/https) and data: references are left untouched (we embed everything, but the
// inliner is generic so later phases can split into modules under src/).
function inlineAssets(html, baseDir) {
  html = html.replace(
    /<link\b[^>]*\brel=["']?stylesheet["']?[^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
    (m, href) => /^(https?:|data:|\/\/)/.test(href) ? m : `<style>\n${readFileSync(resolve(baseDir, href), 'utf8')}\n</style>`
  );
  html = html.replace(
    /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (m, src) => {
      if (/^(https?:|data:|\/\/)/.test(src)) return m;
      // Escape any literal </script> in the JS so it can't terminate the inlined block.
      const js = readFileSync(resolve(baseDir, src), 'utf8').replace(/<\/script>/gi, '<\\/script>');
      return `<script>\n${js}\n</script>`;
    }
  );
  return html;
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';

// 1. Build the payload (inline everything).
let payload = readFileSync(join(SRC, 'index.html'), 'utf8');
payload = inlineAssets(payload, SRC);

// 2. Compress + base64.
const gz = gzipSync(Buffer.from(payload, 'utf8'), { level: 9 });
const b64 = gz.toString('base64');

// 3. Verify the gzip roundtrip server-side (the browser's DecompressionStream is the runtime twin).
if (gunzipSync(gz).toString('utf8') !== payload) {
  throw new Error('gzip roundtrip mismatch — aborting');
}

// 4. Embed the payload into the loader template.
const loaderTpl = readFileSync(join(ROOT, 'loader.html'), 'utf8');
const placeholders = loaderTpl.split('__PAYLOAD_B64__').length - 1;
if (placeholders !== 1) {
  throw new Error(`loader.html must contain exactly one __PAYLOAD_B64__ placeholder, found ${placeholders}`);
}
const loader = loaderTpl.replace('__PAYLOAD_B64__', () => b64); // function form: avoid `$` interpretation

// 4b. End-to-end check: re-extract the embedded base64 from the built loader and confirm it
//     decompresses back to the exact payload (guards against placeholder/escaping mistakes).
const embedded = loader.match(/var PAYLOAD_B64 = "([^"]*)";/);
if (!embedded) throw new Error('could not find PAYLOAD_B64 in the built loader');
if (gunzipSync(Buffer.from(embedded[1], 'base64')).toString('utf8') !== payload) {
  throw new Error('embedded payload does not decode back to the source — aborting');
}

// 5. Emit outputs.
if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'xnet.html'), loader, 'utf8');
const dataUrl = 'data:text/html;base64,' + Buffer.from(loader, 'utf8').toString('base64');
writeFileSync(join(DIST, 'xnet.dataurl.txt'), dataUrl, 'utf8');

// 6. Report.
const ratio = (Buffer.byteLength(payload) / b64.length).toFixed(1);
console.log('Xnet build ✓');
console.log('  payload (html)            ', kb(Buffer.byteLength(payload)));
console.log('  payload gz+base64         ', kb(b64.length), `(${ratio}× smaller than raw)`);
console.log('  loader  dist/xnet.html    ', kb(Buffer.byteLength(loader)));
console.log('  data:   dist/xnet.dataurl.txt', kb(dataUrl.length), '(chars)');
