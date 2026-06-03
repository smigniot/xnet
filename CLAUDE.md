Project

* This project is named Xnet, after Cory Doctorow's book Little Brother
* Governing principle: least server possible — STUN excepted. The running app contacts only STUN (TURN opt-in); a delivery host serves the static file once and is never called back. Nothing in the conversation to surveil, censor, or take down.
* The deliverable is one self-contained HTML "binary", byte-identical on every mirror, with no runtime dependence on the host that served it. To keep it small, it is a tiny loader that self-decompresses (gzip via DecompressionStream) into the full HTML page.
* The page embeds a minimal copy of gun.js and the software (see below). gun.js is embedded, not loaded from a CDN.
* Delivery forms of that one file: the blessed home is a hosted `https` mirror — durable storage on desktop AND mobile, installable via Add-to-Home-Screen, and the shareable single-link. A `data:` URL has no storage (opaque origin) and is desktop-only (Android blocks top-level `data:`); it is a spread/seed + deniable ephemeral session. Crypto works on every origin via pure-JS (TweetNaCl) — only storage doesn't. Advanced users may download the one file and run it from `file://` on desktop for a sovereign, offline copy.
* Self-propagation: a running instance can regenerate its own installer (data URL / downloadable HTML) on demand, so the tool spreads device-to-device with no server. Clones are data-free by default.

Software

* The software is a chat room, with room management
* The user can create, rename, unjoin "rooms" - they are never deleted, only unjoined
* The user can see new message count in its current rooms
* The user can enter a room, see new messages and send messages
* HARD REQUIREMENT — "meet once": Alice and Bob do the QR exchange exactly once. After that first contact, reconnecting, sharing new rooms, and introducing new people all happen WITHOUT another QR meeting.
* First contact: Alice clicks a button on the room title and a QR appears. It carries the WebRTC SDP/ICE offer PLUS her identity public key and the room descriptor (id, secret, name). Bob scans it (by photo/upload — no live camera), accepts, and shows an answer QR Alice scans back. The channel opens and both persist each other as contacts.
* After first contact, signaling is relayed over the gun mesh itself (a private per-pubkey node), so reconnection and transitive introductions need no new QR. Caveat: if a whole group is offline and addresses changed, a one-time re-QR may be needed (no serverless rendezvous exists).
* STUN is the only server the running app contacts: several servers tried in parallel (Google primary; Cloudflare, Twilio, Nextcloud:443, Metered:80 fallbacks) plus a LAN-only/no-STUN toggle, all user-editable. No free public TURN exists; users may supply their own TURN credentials (opt-in — a TURN server would see traffic).
* The main way to exchange messages in a room is gun.js among all participants (Carol may also join). gun relays transitively, so a spanning tree of WebRTC links suffices. gun is initialized with NO default relay peers, so room data never touches a third-party server.
* Crypto is pure-JS (TweetNaCl), so it works on every origin including `data:`. Identity = ed25519 (sign) + x25519 (box) keypairs. Message and file content is encrypted per room with NaCl secretbox (key from the room secret); signaling is encrypted to the recipient. Routing metadata (roomId, member pubkeys, timestamps) stays clear so gun can sync; only content is sealed.
* Document exchange: users can send a file into a room. It streams directly over the WebRTC data channel (not through gun), and is download-only — never persisted. Files vanish when participants leave, by design.
* Rooms and conversations are persisted in the browser with a local-only eviction policy. Eviction is storage-pressure driven: nothing is evicted while the browser still allows storage; eviction triggers at ~70% of the allowed quota and frees oldest-first down to ~50%. Eviction is local only — if Alice has older messages but Bob evicts them, they remain in Alice's storage until Alice's own eviction triggers.

Notes / settled investigations

* Self-decompressing data URL: ADOPTED (the loader gzip-decompresses the payload).
* Subresource Integrity / CDN gun.js: REJECTED — it reintroduces a runtime network dependency, against the no-server principle. gun.js is embedded.
