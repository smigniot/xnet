# Phase 2 — Design Review & Open Decisions

Purpose: a calm, readable record of the consistency review of `CLAUDE.md` + `DESIGN.md`
against the project's real goals, plus the decisions that follow. **Nothing here is built yet.**
Read at your own pace; the decisions are listed at the end (§7).

---

## 1. The yardstick

**Absolute must-haves (non-negotiable):**
- **No surveillance** — no third party can read who-says-what.
- **Easy chat, out of earshot** — ordinary people, including on phones, can actually use it.

**Supporting goals:**
1. A **single-bookmark link** to open the app.
2. **Chat with friends easily.**
3. **Stays widespread even after the project is (tentatively) banned.**

Everything below is judged against these.

**Governing principle (decided): least server possible — STUN excepted.**
The *only* server ever contacted is a **STUN** server, used for NAT discovery. It learns that
some IP sent a binding request and when — **never** your messages, room IDs, or contacts.
Everything else (signaling-after-first-contact, messages, files, sync) is peer-to-peer. We use
**several** STUN servers for redundancy and keep a **LAN-only / no-STUN** toggle for users who
won't tolerate even that IP-binding leak.

STUN list (Google primary + fallbacks; :443/:53 ports survive restrictive networks):
- `stun.l.google.com:19302`, `stun1.l.google.com:19302` … `stun4.l.google.com:19302` — primary
- `stun.cloudflare.com:3478` — independent
- `global.stun.twilio.com:3478` — anycast
- `stun.nextcloud.com:443` — port 443, censorship-resistant
- `stun.relay.metered.ca:80` — port 80 fallback

The app tries several in parallel, uses whichever answers, and lets the user edit the list, so no
single STUN server is a point of failure.

---

## 2. Verdict in one paragraph

The two design docs agree with each other, and the *privacy mechanisms* are sound. But measured
against the goals there is **one central tension** and **a few real surveillance gaps**. The
short version: as currently written, **the form that spreads best (the `data:` URL) is also the
most ephemeral and the least private**, while the goals demand an entry point that is easy,
persistent, mobile, shareable — *and* private even in the spread form. Two realignments fix this
(§3 and §4). The rest are metadata-hardening and polish (§5–6).

---

## 3. Central tension — the `data:` URL can't be both "the thing that spreads" and "the daily home"

We decided `data:` = ephemeral, and persistence = save-to-disk. That collides with goals 1 & 2:

- **Ephemeral by bookmark.** If the bookmark *is* the `data:` URL, every open is a fresh session — no identity, no contacts, no "meet once." The easiest path gives the weakest experience: a friend who comes back tomorrow has lost everyone.
- **Browsers fight top-level `data:` navigation.** Script/redirect-initiated top-level `data:` navigation is blocked in all modern browsers; user-typed/bookmarked `data:` is inconsistent — usually OK on desktop, **largely broken on mobile** (iOS Safari and Android Chrome are hostile to both `data:` and `file://` as openable, storage-bearing origins). Since "everyone / friends" implies phones, this is a **feasibility risk, not a UX nit.**
- **An 80–150 KB URL isn't shareable.** Fine as a personal bookmark; impossible to put in an SMS, a chat message, or a QR. So the `data:` URL is not really "a link you hand to a friend."

### The proposed fix — sharpen what "no server" means

> **"No server in the *data* chain."** Signaling-after-first-contact, messages, and files stay
> pure peer-to-peer and end-to-end — **no server ever sees them.** But *delivering the static app
> shell* may use **interchangeable, mirror-able hosts** (any static `https`, an IPFS gateway, a
> friend's box) **or no host at all** (the self-contained file / `data:` URL). A host that only
> ever serves a public app download — never a message — is **not** a surveillance surface.

Why this helps every goal without weakening privacy:

| Form | Goal 1: one bookmark | Goal 2: easy, mobile | Goal 3: ban-resistant | Message privacy |
|---|---|---|---|---|
| `data:` URL | desktop personal bookmark only | ✗ mobile | ✓ paste/seed anywhere | ✓ *if* §4 adopted |
| Saved `.html` (`file://`) | ✓ desktop | ✗ mobile | ✓ copyable file | ✓ |
| **Hosted static mirror + "Add to Home Screen" PWA** | ✓ | ✓ **incl. mobile, persistent** | ✓ **mirrors interchangeable — ban one ⇒ switch** | ✓ (data path still P2P) |

Self-propagation (DESIGN §4.5) becomes the ban-resistance engine: any instance can **export a
fresh copy to re-host**, so taking down mirror A just means re-publishing to mirror B / IPFS,
and the file/`data:` form is the offline sneakernet fallback (the *Little Brother* XNet spirit).

**Recommendation:** treat the self-contained HTML as a *spreadable seed*, and make a
**mirror-able hosted/PWA instance the recommended daily home** (persistent, mobile, single-tap),
with `file://` and `data:` as sovereign offline fallbacks. (Decision **D1** + **D2**.)

*If you truly want literal zero-server-ever including app delivery, that's legitimate — but then
"single-bookmark link" and "everyone/mobile" shrink to "desktop power users," because that's what
is physically achievable.*

---

## 4. Surveillance gap — the spread-form is currently the *least* private

This cuts straight against the prime directive:

- **DTLS in the mesh is hop-by-hop, not end-to-end.** A message Alice → Carol *via Bob* is decrypted at Bob. Our per-room AES-GCM is the **only** thing that makes the transitive mesh private (a non-member relaying ciphertext can't read it). So app-layer encryption is **mandatory**, not "hardening."
- **But we tied encryption to WebCrypto/SEA, which needs a secure context** — so the `data:` spread-form has *no* app-layer encryption, meaning relayed messages there are readable by intermediate peers. The form designed to spread widely is the one with the weakest privacy. Backwards.

**Recommendation:** bundle a **pure-JS crypto** primitive (e.g. TweetNaCl, ~tens of KB, or a
minimal AES-GCM-JS) so message/file encryption works **even on `data:`/insecure origins**.
WebCrypto/SEA stays as the fast path when available. Note the clean split: *persistence* is
genuinely impossible on `data:` (no storage API exists at all), but *encryption* is **not** — we
just chose a WebCrypto-only path. Decoupling them keeps the spread-form private. (Decision **D3**.)

---

## 5. Metadata & network-level surveillance (under-addressed in DESIGN §9)

Content is well protected; *metadata* — what real surveillance targets — is not yet:

- **Disable gun's default public relay peers explicitly.** Out of the box gun connects to public relays; if we don't init with an empty peer list, room data silently traverses a third-party server. Must be an explicit, audited line — the difference between true P2P and "accidentally routing through someone's server."
- **Encrypt the `signal/<pub>` payloads to the recipient, not just sign them.** SDP/ICE contains **IP addresses**; if signaling is only signed, every relaying peer reads everyone's IPs. Encrypt-to-pubkey closes that.
- **STUN is the one accepted server (decided — see §1).** Keep Google as primary, add several fallbacks for redundancy/censorship-resilience, and offer a LAN-only/no-STUN toggle. STUN sees only an IP doing a binding request — never content or who-talks-to-whom — so it does not breach the no-surveillance directive.
- **Inherent P2P IP exposure.** Peers learn each other's IPs by design (no free TURN to hide behind). A hostile "friend" gets your IP. Unavoidable in serverless P2P, but it must be **stated** in the threat model so users understand the trust boundary. WebRTC can also be DPI-blocked wholesale on hostile networks (residual goal-3 risk worth naming).

(These are mostly "do them" rather than open choices — gathered as Decision **D4** so you can confirm/trim.)

---

## 6. Easy-chat friction (goal 2) and smaller notes

- **First contact need not be in-person.** Because scanning is photo/upload, Alice and Bob can exchange QR *images* over any channel (Signal, email, AirDrop). Making remote first-contact explicit makes "chat with friends easily" far truer; the surveilled channel only ever sees SDP (IPs), never messages. (Decision **D5**.)
- **Meet-once friction vanishes with a persistent home.** In ephemeral `data:` mode you re-meet every session; with the persistent PWA/file home (§3), meet-once "just works." Another reason to adopt D2.
- **Size budget omits SEA / pure-JS crypto.** Realistic data-URL size likely ~120–160 KB, not 80–110 KB. (No decision; just accuracy.)
- **`navigator.storage.estimate()`/`persist()` need a secure context** — consistent with "no persistence on `data:`"; watermark eviction runs only at the re-homed origin, with the absolute-cap fallback elsewhere. (No decision.)
- **CLAUDE.md wording:** "the deliverable *is* a `data:` URL" should soften to "a self-contained HTML app, deliverable as a hosted mirror, a file, or a `data:` URL," so the daily UX isn't contractually bound to the `data:` form. (Follows from D1/D2.)

---

## 7. Decisions to make

Each decision lists options, the trade-off, and my recommendation (marked ★). The option
write-ups are kept for the record; **final answers are summarised here.**

### ✓ Resolved (all Phase-2 decisions)
| # | Decision | Outcome |
|---|---|---|
| **D1** | Delivery model | **Distinction** — may be delivered by a server, but always one self-contained, mirror-able HTML file with **no runtime host dependence**; only STUN while communicating (TURN opt-in). |
| **D2** | Daily home | **(b) Hosted `https` is the blessed home on all platforms** — durable on desktop + mobile (spike), and the shareable single-link (goal 1). Advanced users may download the one file and run it from `file://` on desktop (sovereign/offline); `data:` is a desktop-only seed. |
| **D3** | Crypto reach | **Pure-JS crypto everywhere** — the `data:` form *can* chat, so messages/files are E2E-encrypted on every origin incl. `data:`. |
| **D4** | Metadata hardening | **All three adopted:** encrypt signaling to recipient · disable gun's default relays (also entailed by §1) · document IP exposure. |
| **D5** | Remote first contact | **Adopted** — exchange QR images over any channel, not just in-person. |
| **D6** | Feasibility spike | **Done** (results in DESIGN §2.4 / `spike-result-*.txt`). Key facts: WebRTC+STUN+gzip work on every origin that runs; `data:` is desktop-only (Android blocks top-level `data:`); `file://` durable on desktop only; Android saved-file = non-durable `content://`; hosted `https` durable everywhere; TweetNaCl viable everywhere (WebCrypto absent on `data:`). |
| Crypto lib | Identity + rooms + signaling | **TweetNaCl everywhere** — ed25519 sign + x25519 box (identity/signaling), secretbox (rooms); gun for graph sync only; one code path; works on every origin. Replaces SEA for crypto. |
| Cold-start relay (T9b) | Rendezvous when group fully offline | **Keep deferred** — purist + last-resort direct retry; worst case a one-time re-QR. |

Original option write-ups follow.

---

### D1 — Does "least server, STUN excepted" forbid a one-time delivery host? — ✓ DECIDED: Distinction
**Resolved:** the app **may be delivered by a server**, but it stays **one self-contained single
HTML file**, byte-identical on every mirror, with **no runtime dependence on the host** (once
loaded it never calls back). While communicating, **only STUN** is used (TURN opt-in). A delivery
host is just "where you downloaded it" — mirror-able and replaceable, not a server in the
conversation. Consequence (single-file ⇒ no service worker → hosted needs network to *load* but
not a *particular* host; true offline = saved `file://` copy) is documented in DESIGN §2.1.
The original framing is kept below for the record.


Context: STUN is now the one accepted server (§1). The question is whether *delivering the static
app file* counts as another server to avoid. Note the leak profiles differ:
- **STUN:** the running app talks to it *every session*; it learns your IP + timing.
- **Delivery host:** touched *once at load*, by the browser, to fetch a public file; it never speaks to the app at runtime, sees no messages, and is freely mirror-able/replaceable. Arguably *less* exposing than STUN, and avoidable by using the `file://`/`data:` copy.

Options:
- **(Strict)** STUN is the *only* server, period — delivery must also be serverless (`file://` + `data:` only). Purest reading; but **mobile stays broken** and "a link you hand a friend" isn't really achievable. Relies on `data:`/file spreading + self-propagation (§4.5) for reach.
- **(Distinction)** "Least server" forbids only **runtime data-path** servers; a **one-time, content-only, mirror-able delivery host** (any static `https`/IPFS, or a friend's box) is allowed. The *running* app still contacts only STUN. Unlocks mobile + shareable link + ban-resistance via interchangeable mirrors.
- *Privacy of messages is identical either way; the difference is reach/ease vs. literal purity.* **This decision gates D2.**

### D2 — Recommended daily home (how friends actually run it)
- ★ **Hosted/PWA mirror** (persistent, mobile, single-tap) **+ file/`data:` fallback.** Best for goals 1, 2, 3; makes meet-once effortless.
- **Saved `file://` app** (desktop-persistent) + `data:` seed. Serverless, but desktop-only.
- **`data:` URL bookmark** as primary. Simplest to ship, but ephemeral every session — weakest experience.
- *(D2 depends on D1: the hosted option only exists under D1 = "data chain".)*

### D3 — Does encryption work in the spread (`data:`) form?
- ★ **Bundle pure-JS crypto** → messages/files E2E-encrypted **everywhere**, including `data:`. Costs ~tens of KB.
- **WebCrypto/SEA only.** Smaller, but the `data:` spread-form has no app-layer encryption → relaying peers can read messages. (Conflicts with the prime directive.)
- **WebCrypto/SEA + restrict ephemeral mode to single-hop only** (no relayed messages when unencrypted). Keeps purity but cripples the mesh in the spread-form.

### D4 — Metadata hardening (confirm the set; all recommended)
- ✓ **STUN decided (§1):** keep Google primary + several fallbacks; LAN-only/no-STUN toggle. STUN is the sole accepted server.
- **Encrypt** signaling payloads to the recipient (not just sign).
- **Explicitly disable** gun's default public relay peers.
- Document **inherent IP exposure** (peer-to-peer + STUN) honestly in the threat model.

### D5 — Remote first contact
- ★ **Explicitly support** exchanging QR *images* over any channel (not just in-person screen scans).
- In-person only.

### D6 — Mobile feasibility spike before committing
- Run a quick spike on real iOS Safari + Android Chrome to confirm what actually opens/persists (`data:`, `file://`, hosted PWA) **before** building, so D1/D2 rest on evidence.
- Defer; decide on reasoning alone.

### Carried-over (from earlier phases, still open)
- **Cold-start relay (T9b):** optional user-supplied self-hosted relay for when a whole group is offline + addresses changed — include now or keep deferred?
- **Identity crypto library:** gun SEA vs. TweetNaCl-based (links to D3 — if D3 = pure-JS, identity likely uses the same lib).
