# Xnet — Design

> A self-contained, peer-to-peer chat application built on the principle **least server
> possible — STUN excepted** (§0): the running app contacts only STUN for NAT discovery, never a
> server that sees content or metadata. It ships as a single self-decompressing HTML "binary",
> bootstraps peers via QR-coded WebRTC signaling, and syncs rooms with an embedded copy of
> gun.js. Named after the XNet in Cory Doctorow's *Little Brother*: a tool that spreads
> device-to-device with **no server in the conversation** to surveil, censor, or take down.

> **⚠ Active design review (Phase 2).** This document captured the first agreed design. A
> review against the prime directives — *no surveillance* and *easy chat out of earshot* — is
> complete in **`PHASE2.md`**; its outcomes are folded in here. Summary:
> - **Least server possible — STUN excepted** (§0): STUN is the only server the running app contacts (several fallbacks); a delivery host serves the static file once and is never called back (D1).
> - **D1:** delivered by a server is allowed, but always **one self-contained, mirror-able HTML file with no runtime host dependence**; three forms — hosted, `file://`, `data:` (§2.1).
> - **D2:** **hosted `https` is the blessed home on all platforms** (durable on desktop+mobile, the shareable single-link). Advanced users may download the one file and run it from `file://` on desktop; `data:` is a desktop-only seed.
> - **D3:** the `data:` form *can* chat → **pure-JS crypto (TweetNaCl) everywhere**, so messages/files are E2E-encrypted on every origin including `data:`.
> - **D4:** **encrypt signaling to recipient · disable gun's default relays · document IP exposure** (all adopted).
> - **D5:** remote first contact (exchange QR images over any channel) — adopted.
> - **D6:** spike **done** (§2.4) — WebRTC/STUN/gzip work everywhere that runs; `data:` is a desktop-only seed (Android blocks it); only `https` gives a durable mobile home.
> - Cold-start relay: deferred.
>
> **All Phase-2 decisions are now settled** (D2 resolved to hosted-`https` home per §2.4). Ready for the build (phased plan §11).

---

## 0. Governing principle — least server possible, STUN excepted

The **only** server the running app ever contacts is a **STUN** server (NAT discovery). STUN
learns that some IP sent a binding request and when — **never** messages, room IDs, or contacts.
Everything else — signaling after first contact, messages, files, sync — is peer-to-peer. We use
several STUN servers for redundancy and offer a **LAN-only / no-STUN** toggle for users who won't
tolerate even that IP-binding leak. A *delivery host* (§2.1) is **not** a server "in the
conversation": it serves the static file once and the running app never calls back to it.

---

## 1. Goals & non-goals

**Goals**
- **One file, least-server (STUN excepted).** The whole app is a single HTML file; at runtime it contacts only STUN (§0). No deployment of a data-path server.
- **Rooms:** create / rename / unjoin (never deleted, only unjoined), unread counts, read & send messages.
- **Peer onboarding by QR** carrying WebRTC SDP/ICE for *first contact only*.
- **Message transport via an embedded gun.js mesh** over WebRTC data channels.
- **Meet once (hard requirement):** after a single QR meeting, two people never need another — reconnection, new rooms, and introductions all happen without a further scan (§5).
- **Local persistence** with a **local-only**, storage-pressure-driven eviction policy.
- **Per-room encryption** of message content.
- **Document exchange:** send a file into a room; members accept and download it.
- **Self-propagation:** a running instance regenerates its own installer on demand, so the tool spreads peer-to-peer with no server involved.

**Non-goals (v1)**
- Server-assisted signaling, presence, or any relay/CDN dependency at runtime.
- Push notifications, voice/video.
- Persisted file storage (files are download-only and ephemeral — §5.6).
- Global moderation or true global message deletion (impossible in a P2P CRDT — §6.3).

---

## 2. Platform constraints & resolutions

Three browser realities shape the architecture.

### 2.1 One self-contained file, three delivery forms (D1 resolved)

**Decision (D1):** the app may be **delivered by a server**, but it is always **one self-contained
single HTML file**, byte-identical on every mirror, with **zero runtime dependence on the host
that served it**. Once loaded it never calls back to that host; the only server the running app
ever contacts is STUN (§0), TURN opt-in. So a delivery host is just "where you downloaded the
file," freely mirror-able and replaceable — not a server "in the conversation."

The same file runs from three origins, trading purity for reach:

| Delivery form | Origin | Persistence | Encryption | Role (D2) |
|---|---|---|---|---|
| **Hosted** (`https://` mirror / IPFS) | secure, stable | ✅ durable on desktop **and mobile**; **Add-to-Home-Screen** persists | ✅ TweetNaCl | ★ **blessed home, all platforms** — the shareable single-link (goals 1–2), spike-confirmed durable everywhere |
| **Saved file** (`file://`) | stable (desktop only) | ✅ desktop (shared `file://` store); ✖ on mobile (becomes non-durable `content://`) | ✅ TweetNaCl | **advanced / offline desktop** option — host-independent sovereign copy |
| **`data:` URL** | opaque, non-secure | ❌ none (no storage API exists there) | ✅ TweetNaCl (pure-JS; WebCrypto absent but unused) | **desktop-only** spread/seed + deniable ephemeral one-off (Android blocks `data:`) |

Notes & consequences:
- **D2 (decided): the hosted `https` instance is the blessed home on every platform.** It's the single-bookmark shareable link (goal 1) and the only durable mobile home (spike §2.4). The host serves only the static file; the running app never calls back to it (D1), so it stays mirror-able and host-independent in spirit.
- **Advanced/offline desktop option:** users may **download the one HTML file** and run it from **`file://`** for a fully sovereign, server-free copy (desktop only — spike shows mobile saved-files are non-durable `content://`).
- **`data:` is ephemeral by nature and desktop-only** — opaque origins have *no* storage API (identity/contacts/rooms can't persist), and Android blocks top-level `data:` entirely. It remains a desktop spread/seed and deniable throwaway session.
- **Single-file ⇒ no service worker.** A SW script must be a separate same-origin file, so a one-file app can't register one. Consequence: a hosted instance needs the network to **fetch the HTML** on each cold open (or the browser HTTP cache) — it doesn't depend on any *particular* host (mirror-able), but it isn't a fully offline PWA. Full offline = the saved `file://` copy. Honest cost of "one self-contained file." *(A 2-file build with a tiny SW is the lever if full offline-install ever outweighs single-file purity — out of scope for v1.)*
- **Self-propagation (§4.5)** lets any instance emit a fresh copy to re-host or save, so reach never depends on the original host surviving (goal 3).

### 2.2 QR capacity vs. SDP size, and the two-way handshake
A QR holds ~2–3 KB; a raw SDP with ICE candidates is 1–4 KB and a connection needs *both* an
offer and an answer. Resolution:
- **Data-channel-only** peer connection (no audio/video) → small SDP.
- **Non-trickle ICE**: gather to completion (or ~2 s timeout) so one QR carries everything.
- **SDP minification**: keep only `ice-ufrag`, `ice-pwd`, DTLS `fingerprint`, host/srflx candidates; rebuild a canonical SDP on the far side. Then `deflate` (native `CompressionStream`) + Base64URL → a few hundred bytes, comfortably one QR.
- **Two-step handshake:** Alice shows **Offer QR** → Bob scans, generates and shows **Answer QR** → Alice scans Answer → channel opens.
- **Scanning is photo/upload only** (live camera dismissed): `<input type=file accept="image/*" capture>` → decode on canvas via jsQR. Works at every origin including `data:`, needs no `getUserMedia` permission, and on mobile lets the OS camera take the shot.
- Contingency if a payload ever overflows one code: multi-frame animated QR (chunked, reassembled). v1 targets single-frame.

### 2.3 STUN / TURN (the one accepted server — §0)
STUN is the sole server the running app contacts. It only does NAT discovery — no content, no
metadata about who-talks-to-whom — so it is compatible with the no-surveillance directive.
- **Multiple STUN servers, tried in parallel, first to answer wins**, so no single server is a point of failure or a single censor target. Default list (Google primary + fallbacks; :443/:53 ports survive restrictive networks):
  - `stun.l.google.com:19302`, `stun1..4.l.google.com:19302` — primary
  - `stun.cloudflare.com:3478` — independent
  - `global.stun.twilio.com:3478` — anycast
  - `stun.nextcloud.com:443` — port 443, censorship-resistant
  - `stun.relay.metered.ca:80` — port 80 fallback
- **LAN-only / no-STUN toggle** for same-network use with zero STUN leak.
- The list is **user-editable**; non-trickle gathering means one answering STUN is enough.
- **TURN:** none by default (no free public TURN exists). A settings field lets a user paste their own TURN credentials for symmetric-NAT / strict-firewall cases (a TURN server *would* see traffic, so it is opt-in and never default).

### 2.4 Spike results (D6 — measured, not assumed)
Probed with `spike.html` across origins/devices (Firefox 151 desktop/macOS; Chrome 147 + Firefox 149 Android). Raw logs: `spike-result-*.txt`.

| Capability | desktop `file://` | desktop `https` | desktop `data:` | Android `content://`¹ | Android `https` | Android `data:` |
|---|---|---|---|---|---|---|
| JS runs at all | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ **blocked** |
| secure context | ✅ | ✅ | ❌ | ✅ | ✅ | — |
| localStorage / IndexedDB | ✅ | ✅ | ❌ | ✅ | ✅ | — |
| `storage.persist()` | ✅ | ✅ | n/a | ❌ **denied** | ✅ | — |
| WebRTC data channel | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| STUN srflx (Google) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| WebCrypto subtle | ✅ | ✅ | ❌ | ✅ | ✅ | — |
| `getRandomValues` (TweetNaCl) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| gzip streams | ✅ | ✅ | ✅ | ✅ | ✅ | — |

¹ A file saved & opened via Android's Files app runs at `content://<provider>`, *not* `file://`.

**Conclusions:**
- **D3 validated & required:** desktop `data:` *chats* (WebRTC ✅) but has **no WebCrypto and no storage** → pure-JS **TweetNaCl is necessary**, and `getRandomValues` (present everywhere) makes it viable.
- **`file://` is a full, durable home — on desktop only.**
- **`data:` is a desktop-only runtime/seed:** Android **blocks top-level `data:` navigation entirely** (JS never runs). On phones, `data:` cannot be the entry.
- **Mobile has no durable *serverless* home:** Android "saved file" = `content://` with **`persist()` denied** and an origin tied to the opener app (fragile). **Only `https` gives a durable, persistent home on mobile** (and works identically on desktop).
- WebRTC + STUN + self-decompress (gzip) work on **every origin that runs**.

→ **D2 resolved (b):** the **hosted `https` instance is the blessed home on all platforms** — the only durable mobile home and the shareable single-link. Advanced users may still **download the one file and run it from `file://`** on desktop for a sovereign offline copy. Still one self-contained, mirror-able file with no runtime host dependence (D1).

---

## 3. High-level architecture

```
┌─────────────────────────── single HTML "binary" ───────────────────────────┐
│  Loader (tiny)  →  DecompressionStream(gzip)  →  Payload HTML (the app)      │
│                                                                              │
│  Payload runtime:                                                            │
│   ┌────────────┐  ┌───────────────┐  ┌───────────────┐  ┌─────────────────┐ │
│   │   UI layer │  │ Identity +     │  │ Gun mesh core │  │ Signaling       │ │
│   │ (vanilla)  │←→│ rooms/msgs model│←→│ (embedded)   │←→│ QR + mesh-relay │ │
│   └────────────┘  └───────┬───────┘  └───────┬───────┘  └────────┬────────┘ │
│                    ┌───────┴───────┐  ┌────────┴──────┐          │          │
│                    │ Persistence + │  │ RTCDataChannel│←─────────┘          │
│                    │ watermark evict│  │ transport     │  (first contact &  │
│                    └───────────────┘  └───────────────┘   mesh-signaled)    │
└─────────────────────────────────────────────────────────────────────────-─┘
```

- **No framework.** Vanilla JS + minimal CSS to stay small.
- gun.js is **embedded** (minimal build) and bridged onto WebRTC data channels by a thin custom mesh adapter (§5.5).
- Identity/encryption use **TweetNaCl** (pure-JS, works on every origin incl. `data:`); gun is used for graph sync only.

---

## 4. The build artifact (self-decompressing single file)

### 4.1 Layout
- **Payload** = full app HTML: inlined `<style>`, embedded gun.js (minified), QR encode + jsQR decode, app JS. One `index.html`, no external references.
- **Loader** = a few hundred bytes of HTML+JS holding the payload as a gzip'd Base64 string. On load it: Base64-decodes → `DecompressionStream('gzip')` → `document.open(); document.write(text); document.close();` (scripts in the written payload execute).
- **Deliverable** = `data:text/html;base64,<base64 of the loader>`. The payload is gzip'd before its single Base64 pass, so the data URL is meaningfully smaller than base64-ing the raw payload.

### 4.2 Size budget (minified, estimates)
| Component | Raw | Notes |
|---|---|---|
| gun.js (core) | ~90–110 KB | embedded |
| QR encoder | ~10 KB | tiny |
| jsQR decoder | ~50 KB | photo/upload decode |
| TweetNaCl | ~30 KB | pure-JS crypto, all origins |
| App + CSS | ~20–30 KB | mesh, file transfer, UI |
| **Payload** | **~170–200 KB** | |
| gzip | ~60–80 KB | |
| **data URL (base64)** | **~80–110 KB** | |

### 4.3 gun.js delivery: embed
gun.js is **embedded**, not loaded via SRI/CDN. Fully offline, no third-party trust, no network
at load — consistent with the no-server / surveillance-escape goal. (The SRI/CDN variant is
explicitly rejected: it reintroduces a runtime network dependency.)

### 4.4 Build pipeline (`build.mjs`, Node)
1. Inline `src/index.html` + assets (gun, libs, app) into one payload HTML.
2. Minify (terser for JS; simple CSS minify).
3. gzip → Base64 → inject into `loader.html` template.
4. Base64 the loader → write `dist/xnet.html` (raw loader, for `file://` use) and `dist/xnet.dataurl.txt` (the `data:` URL).

> Browser support: `DecompressionStream('gzip')` needs Chrome ≥80, Firefox ≥113, Safari ≥16.4 — documented as a requirement.

### 4.5 Self-propagation — regenerating the installer on demand
The running app reproduces its own installer with **zero server involvement**:
- During boot, the loader stashes the **pristine compressed-Base64 payload** in `window.__XNET_SELF__` *before* `document.write` replaces the document — so the live app always holds an exact, unmutated copy of its own bytes (no DOM serialization, no second copy bloating the file).
- A **Spread / Clone** action re-wraps `__XNET_SELF__` in the loader template and Base64-encodes it → a fresh `data:text/html;base64,…`, offered as: **copy to clipboard** and **download `xnet.html`** (for AirDrop / USB / email). The installer (~80–110 KB) is far too big for a QR, so QR stays strictly for peer connection — distribution is copy/file/airdrop.
- **Clone is data-free by default**: the tool only, no rooms/history (spreading software must not leak conversations). An explicit, off-by-default **"include my rooms"** toggle bakes current state in for personal backup/device migration.
- Regeneration just re-wraps stored bytes (native Base64, no recompression) → instant, byte-identical to the installer this instance came from. The app is a faithful self-replicator.

---

## 5. Networking

> **Hard requirement governing this section — meet once.** Alice and Bob perform the QR dance
> **exactly one time, ever.** Every later interaction — reconnecting after a closed tab, sharing
> a new room, being introduced to a third person — happens **without another QR meeting.**

Two layers: a persistent **contact/transport layer** (peer relationships, established once,
reused forever) and a **room layer** (each room an independent membership + gun namespace).
Meet-once lives in the contact layer; rooms are shared freely between known contacts on top.

### 5.1 First contact — the one and only QR dance
Per §2.2 (data-channel-only, non-trickle ICE, minified+deflated SDP, two-step Offer→Answer,
photo scan). The QR is a **first-contact bootstrap**, carrying more than SDP:
```
{ sdp,                        // minified offer/answer
  pub,                        // initiator's long-term public key (identity)
  room: { id, secret, name }  // the room being shared (sharing is room-scoped)
}
```
When the channel opens, both sides **persist each other as contacts** (pubkey + display name)
and Bob auto-joins the shared room. This is the only time a photo/QR is ever needed for that pair.

### 5.2 Identity & contacts (persistent)
- On first persistent run the app generates a long-term **TweetNaCl identity**: an ed25519
  signing keypair + an x25519 box keypair. The public keys are the peer's durable address; the
  private keys sign and decrypt. (Pure-JS → works even in the `data:` form.)
- A **contact** = `{ pub, displayName, lastSeenHints }`, persisted locally — the durable
  relationship that "meeting once" creates.
- **Consequence:** identity + contacts must survive sessions, so "meet once" holds only at a
  persistent origin. In ephemeral `data:` mode there is no identity to persist, so a meeting
  lasts only that session — hence the Save-to-disk encouragement before a first meeting (§2.1).

### 5.3 Reconnect & introduce — without meeting again (signaling-over-mesh)
After first contact, **the gun mesh itself is the signaling channel.** ICE credentials are
ephemeral, so a dropped link can't literally resume — but a *new* link negotiates through any
existing mesh path, with no QR:
- Each peer watches a private node `signal/<pub>` carrying offers/answers **encrypted to the recipient's box key and signed by the sender** (x25519 box + ed25519). Relaying peers carry ciphertext only — they never see the SDP/IP inside (D4).
- **Reconnect:** Alice writes a fresh offer to `signal/<bob-pub>`; if any mesh path currently reaches Bob (he's online, or a mutual contact relays gun data), he reads it, answers to `signal/<alice-pub>`, and a fresh direct link forms — automatically, no scan.
- **Introduce (transitive):** Carol met only Alice; to reach Bob she writes an offer to `signal/<bob-pub>` which rides the mesh through Alice; Bob answers; the Carol↔Bob link forms. They never meet by QR. Room membership = the set of member pubkeys, gossiped in the room namespace, so everyone can address everyone.
- **Last-resort direct retry (T9c):** before giving up, try each contact's persisted `lastSeenHints` (rescues static-IP / same-LAN cases).

```
First contact (QR, once):     Bob ──QR── Alice ──QR── Carol
Thereafter (mesh-signaled):   Bob ─────── Carol   ← via Alice-relayed signaling, no QR
```

**Cold-start limit (accepted):** mesh signaling needs ≥1 mutual peer online to relay. If a
group is *entirely* offline at once **and** addresses changed since last time, there is no
serverless rendezvous — fundamental to no-server P2P. Worst case is a one-time re-QR. An
optional, user-supplied self-hosted relay for cold reconnection is deferred as a later opt-in.

### 5.4 Topology — transitive sync over a spanning tree
gun is a CRDT graph that **relays transitively**: data flows across any connected spanning tree,
so a tree of WebRTC links suffices (Carol via Alice still gets Bob's messages). The mesh both
carries chat and, via §5.3, heals and extends itself.

### 5.5 Gun-over-WebRTC adapter
gun's stock WebRTC adapter assumes a signaling relay we don't have. We bridge gun's wire protocol
onto our manually-established channels (~50 lines, no relay):
- **gun is initialized with an empty peer list** (`peers: []`, `localStorage:false` for our own store) so it **never connects to its default public relays** — room data never touches a third-party server (D4 / §0).
- `RTCDataChannel.onmessage` → gun input (`gun.on('in', msg)`).
- gun `gun.on('out', msg)` → serialize and `send()` over every open data channel.
- gun's dedup/echo-suppression applies; messages are tagged to avoid loops.

### 5.6 File exchange (direct, download-only)
Files travel **directly over the WebRTC data channel**, never through the gun graph:
- Sender chunks the file and streams it to currently-connected members; a small
  **"📎 \<name\> (\<size\>) offered"** marker is written to the room log so latecomers know it
  existed and can **request a resend** from anyone still holding it.
- Receiver gets an **accept** prompt; on accept, chunks reassemble in memory and trigger a
  browser **download** — nothing is persisted. A configurable **size cap** guards memory.
- **Disappearing by design:** because files are never stored and only live on whoever downloaded
  them, they vanish when participants leave — a privacy feature, not a gap.

---

## 6. Data model

### 6.1 Shared (in the gun graph, synced across peers)
- `room/<roomId>` → `{ id, name, createdAt }` — `roomId` is an unguessable random UUID (a bearer capability); `name` is collaborative (gun HAM last-write-wins).
- `room/<roomId>/members` → set of member **pubkeys** + display names (so any member can address/signal any other — §5.3).
- `room/<roomId>/messages` → a gun **set**; each message `{ id, authorPub, ciphertext, ts }` (content is encrypted — §9).
- `signal/<pub>` → offers/answers **encrypted to the addressee's box key + signed** (mesh-relayed signaling). Transient, addressee-only; relays carry ciphertext.

### 6.2 Local-only (per browser, never synced)
- `identity` → TweetNaCl keypairs (ed25519 sign + x25519 box) + editable `displayName`. Durable; what "meeting once" persists.
- `contacts/<pub>` → `{ displayName, lastSeenHints }` — relationships established at first contact.
- `roomSecrets/<roomId>` → the per-room encryption secret (never synced).
- `membership/<roomId>` → `{ joined: bool, lastReadTs, evictHorizonTs }`.
- App settings (TURN config, eviction watermarks).

### 6.3 Room lifecycle
- **Create:** generate `roomId` + secret, write shared metadata, add self to members, mark joined.
- **Rename:** write `name` (syncs; shared label).
- **Unjoin:** set local `joined=false`, unsubscribe from the room node, hide it. Data is **not** removed from the graph or from peers — "never deleted, only unjoined."
- **Unread count:** messages with `ts > lastReadTs`; entering a room advances `lastReadTs`.

> True global deletion is impossible in a P2P CRDT — any peer still holding data can rebroadcast
> it. "Unjoin" is therefore a local unsubscribe, exactly as specified.

---

## 7. Persistence & eviction

### 7.1 Storage
- gun uses an **IndexedDB-backed** store when storage is available; in-memory otherwise (§2.1).
- On first persistent run, request **`navigator.storage.persist()`** for durable storage so the browser won't silently auto-evict — we manage eviction ourselves.

### 7.2 Eviction — storage-pressure driven, local-only, sticky
**Principle:** don't evict while the browser still has room. Eviction is driven by how full the
origin's storage quota is, not by age or count.

**Watermark scheme** (via `navigator.storage.estimate()` → `{ usage, quota }`):
- **High watermark (HW) = 70 % of `quota`** → trigger eviction.
- **Low watermark (LW) = 50 % of `quota`** (configurable) → stop once back under it.
- The 70 %→50 % hysteresis prevents thrashing (one cleanup frees ~20 % of quota).

```
usage/quota:  0% ────────── 50%(LW) ───── 70%(HW) ───── 100%
                  no action      ▲ stop      ▲ start evicting oldest-first
```

**Algorithm** (on launch, after throttled batches of writes, and on a timer):
1. `{usage, quota} = await navigator.storage.estimate()`.
2. If `usage < HW·quota` → done.
3. Else delete **oldest messages first, globally across joined rooms** (by `ts`), in batches, re-checking `estimate()`, until `usage ≤ LW·quota`.
4. For each room touched, advance its local **`evictHorizonTs`** to the newest `ts` dropped.

**Local-only + sticky** (requirement): eviction on Bob never touches Alice's copy.
`evictHorizonTs` does double duty — (a) prune locally below it, and (b) **filter incoming sync**:
never re-store/display messages with `ts < evictHorizonTs`. Without (b), a peer still holding old
data would re-sync it back and eviction wouldn't "stick." Alice keeps her history until *her own*
storage crosses 70 %.

**Fallback:** if `estimate()` is unavailable/coarse, use a conservative absolute cap (e.g. evict
oldest beyond ~50 MB) with identical watermark logic. HW/LW are exposed in settings.

---

## 8. UI / UX

Single page, primary views + modals. Vanilla DOM, minimal CSS, mobile-friendly. QR scanning is
**photo/upload** (§2.2) — no live camera.

1. **Room list** — joined rooms with unread badges; **＋ Create**, and per row **Rename / Unjoin / Share**. A persistent **Save app to disk** prompt while running ephemerally.
2. **Room view** — message list (new messages visually separated), text input, **Send**, **📎 attach file** (§5.6).
3. **Share dialog** (Alice) — first-contact **Offer QR**, then **upload Bob's Answer image** (only ever needed for a brand-new contact).
4. **Join dialog** (Bob) — **upload Offer image** → show **Answer QR**.
5. **Settings** — display name, TURN config, eviction watermarks (HW/LW), **Spread / Clone** (§4.5), Export/Import state, Save-to-disk.

Per-link connection status (connecting / connected / failed-try-TURN).

---

## 9. Security & privacy

**Encryption is application-layer and works on every origin** — DTLS alone is *not* enough,
because the mesh is hop-by-hop (a relaying peer terminates DTLS and would see plaintext). All
crypto uses **TweetNaCl** (pure-JS), so it engages identically on hosted, `file://`, **and**
`data:` — the spread-form is as private as the saved one.

- **In transit:** WebRTC data channels are DTLS-encrypted per hop; **end-to-end privacy across the mesh comes from the app-layer encryption below**, not from DTLS.
- **Identity & authenticity:** each peer holds a TweetNaCl identity (§5.2); messages carry `authorPub` and are **ed25519-signed**, so authorship can't be forged across the mesh.
- **Capability model:** a room is reachable only by knowing its unguessable `roomId` **+ secret** (carried in the invite/QR). Possession = access.
- **Per-room encryption (mandatory, all origins):** message bodies and file-chunk payloads are sealed with **NaCl secretbox** (XSalsa20-Poly1305) under a key derived from the room **secret**. A relaying non-member carries only ciphertext. Routing metadata (roomId, member pubkeys, timestamps) stays clear so gun can sync; only *content* is sealed.
- **Signaling encryption (D4):** `signal/<pub>` offers/answers are **box-encrypted to the recipient** and signed, so relaying peers never read the SDP/IP inside.
- **No third-party relay (D4 / §0):** gun starts with an empty peer list — room data never traverses a public relay. The only server contacted is STUN.
- **At rest:** stored content is ciphertext; the room secret + identity private keys are the sensitive local items (local-only, never synced). *(In the `data:` form there is no at-rest storage at all — nothing is written.)*
- **Threat model — what is and isn't protected (honest):**
  - *Protected:* message/file **content** (E2E, even through relays and at rest), authorship, signaling content.
  - *Exposed by design:* **your IP address** — peers you connect to learn it (inherent to serverless P2P; no free TURN to hide behind), and STUN servers learn that some IP did a binding request + timing. A hostile "friend" therefore learns your IP. Use the **LAN-only/no-STUN** mode or your own TURN to mitigate.
  - *Residual:* a hostile network can **DPI-block WebRTC** wholesale; metadata like *who is in a room* is visible to room members (expected) and room-graph **timing/size** is visible to relaying members.
- **No analytics, no external calls** beyond STUN (and an opt-in TURN, which *would* see traffic — never default).

---

## 10. Proposed file layout

```
Xnet/
├── CLAUDE.md
├── DESIGN.md            ← this file
├── build.mjs            ← inline → minify → gzip → base64 → data URL
├── loader.html          ← self-decompress template
├── src/
│   ├── index.html       ← payload shell (inlined style)
│   ├── app.js           ← UI, room/message model, controllers
│   ├── identity.js      ← TweetNaCl identity, contacts, per-room secrets/crypto
│   ├── vendor/nacl.min.js ← TweetNaCl (pure-JS crypto, all origins)
│   ├── store.js         ← persistence + watermark eviction (IndexedDB / in-memory)
│   ├── mesh.js          ← gun ↔ RTCDataChannel adapter
│   ├── signaling.js     ← RTCPeerConnection, SDP minify/expand, first-contact + mesh-relay
│   ├── files.js         ← chunked direct file transfer
│   ├── qr.js            ← QR encode + jsQR decode (photo/upload)
│   └── vendor/gun.min.js
└── dist/                ← build outputs (xnet.html, xnet.dataurl.txt)
```

---

## 11. Phased implementation plan

0. **Feasibility spike (D6) — do this first.** A throwaway `spike.html` (one self-contained file) that probes, on real desktop + iOS Safari + Android Chrome, each as `data:` / `file://` / hosted `https`: does it open? does `RTCPeerConnection` + a loopback data channel work? `localStorage`/IndexedDB available? `storage.estimate()`/`persist()`? `CompressionStream`? `crypto.getRandomValues` (TweetNaCl needs it)? Add-to-Home-Screen persistence? It prints a pass/fail table to copy back. **Gates D2/D3 assumptions before any product code.**
1. **Skeleton + build pipeline** — payload shell, loader, gzip/base64, working data URL that renders. Prove self-decompress + browser support. Wire **Spread/Clone** (§4.5) early so propagation is testable.
2. **Local model + persistence + identity** — TweetNaCl identity, contacts, rooms CRUD, messages, unread counts, IndexedDB + in-memory fallback, `storage.persist()`, watermark eviction with sticky horizon. Detect origin → ephemeral vs persistent mode + Save-to-disk nudge. Usable offline / single-peer.
3. **gun embed + mesh adapter** — embed gun.js with **empty peer list (no default relays)**, bridge gun over a stubbed/in-page transport, verify CRDT sync + per-room secretbox seal/unseal.
4. **First-contact WebRTC + QR** — data-channel pairing, SDP minify, two-step Offer/Answer QR, photo/upload scan, pubkey+room bootstrap, STUN, TURN settings.
5. **Meet-once mesh** — `signal/<pub>` over the gun mesh: reconnect + transitive introduction with no re-QR (§5.3); last-resort direct retry; Alice↔Bob↔Carol transitive sync; connection status UI.
6. **File exchange** — chunked direct transfer, accept prompt, download-only, size cap, "offered"/resend marker (§5.6).
7. **Hardening** — size optimization, multi-frame QR contingency, polish.

---

## 12. Decisions summary

Legend: **✓ settled** · **◔ pending evidence** (the D6 spike, Phase 0).

| # | Decision | Status |
|---|---|---|
| Governing principle | **Least server possible — STUN excepted** (§0). | ✓ |
| STUN/TURN | Several STUN servers (Google primary + fallbacks, §2.3), parallel/first-answer, user-editable, LAN-only toggle; TURN opt-in only. | ✓ |
| QR signaling | Minified SDP, two-step Offer→Answer dance, **photo/upload scan only** (live camera dismissed). | ✓ |
| gun.js | **Keep** (battle-tested; room to evolve) and **embed** (offline, no third party; SRI/CDN rejected). | ✓ |
| Connection model | Room-scoped sharing layered over a persistent **contact** layer. | ✓ |
| Meet once (HARD) | QR is first-contact only; reconnect & introductions are **mesh-signaled, zero further dances**. | ✓ |
| Cold start | Purist + last-resort direct retry; optional self-hosted relay deferred. | ✓ |
| File exchange | **Direct** over data channel, **download-only**, vanishes when peers leave. | ✓ |
| Eviction | **Storage-pressure watermarks** — evict at 70 % of quota down to 50 %, oldest-first, sticky horizon. | ✓ |
| **Delivery / runtime model (D1)** | **May be delivered by a server**, but always **one self-contained, mirror-able HTML file with no runtime host dependence**; only STUN contacted while communicating (TURN opt-in). Three forms: hosted (easy mobile home), `file://` (host-independent), `data:` (ephemeral seed). §2.1. | ✓ |
| Daily home (D2) | **Hosted `https` is the blessed home on all platforms** (durable desktop+mobile per spike §2.4; the shareable single-link). **Advanced/offline:** download the one file and run from `file://` on desktop. `data:` = desktop-only seed. | ✓ |
| `data:` vs persistence | `data:` is ephemeral (no storage API exists there); persistence + meet-once live at a stable origin (hosted or `file://`). | ✓ |
| Crypto (D3 + lib) | **Pure-JS TweetNaCl everywhere** — E2E on every origin incl. `data:`. ed25519 sign + x25519 box (identity/signaling) + secretbox (rooms). Replaces SEA; gun for graph sync only. | ✓ |
| Encryption is mandatory | App-layer encryption (not DTLS) provides E2E across the hop-by-hop mesh; always on. | ✓ |
| Metadata hardening (D4) | **Encrypt signaling to recipient · disable gun's default relays · document IP exposure** — all adopted (§9). | ✓ |
| Remote first contact (D5) | Exchange QR images over any channel, not just in-person. | ✓ |
| Feasibility spike (D6) | **Done** (§2.4). WebRTC/STUN/gzip work everywhere that runs; `data:` desktop-only (Android blocks it); only `https` is a durable mobile home; TweetNaCl viable everywhere. | ✓ |
