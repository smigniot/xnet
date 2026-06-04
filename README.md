# Xnet

Encrypted, offline-capable chat — a single-page app over [Gun.js](https://gun.eco).
Named after the underground network in Cory Doctorow's *Little Brother*.

* End-to-end encrypted **one-on-one** messages (ECDH per pair).
* End-to-end encrypted **shared rooms** (a long-term symmetric key per room).
* The relay server only ever sees ciphertext — it is a dumb mailbox.
* Keeps working when the server goes away: once peers are connected they sync
  directly, and the whole app is cached by a service worker so it boots offline.
* No build step. Vanilla JS + a single Node process. One Docker image.

## Run locally

```bash
npm install
npm start
# open http://localhost:8765
```

Open it in two different browsers (or one normal + one private window), sign up
as two users, search one from the other, and start chatting.

## How it works

| Concern | Approach |
| --- | --- |
| Identity | Gun **SEA** keypair. Sign up with `username + passphrase`; the passphrase derives your keys so you can log in from any device. |
| Backup / migration | **Export keypair** (menu) downloads your key file. **Import a keypair file…** on the login screen logs you back in with it. |
| Finding people | Public **username directory** (`alias -> public key`). Search by username. |
| 1:1 encryption | `SEA.secret(theirEpub, myPair)` ECDH shared secret; messages signed then encrypted. |
| Rooms | A random symmetric key per room, stored **encrypted to yourself** in your user space. |
| Joining a room | Alice sends Bob the room key over their already-encrypted 1:1 channel (an *invitation* message). Bob accepts → he stores the key. This is the "re-encrypt the symmetric key with Bob's key" step. |
| Offline boot | Service worker (`public/sw.js`) precaches the app shell + the Gun library. |
| Real-time | Gun's native `.on()` subscriptions push updates as fast as the mesh allows. |

### Durability — where messages actually live

This is verified behaviour, not a hopeful claim:

* **Clients are the source of truth.** Each browser keeps its own durable copy in
  **IndexedDB** (`public/js/store.js`); Gun runs memory-only as a transport. On
  load the app boots from IndexedDB — it shows full history even with the relay
  down (verified with Playwright: kill the relay, reload, history is still there).
  Two participants re-sync the next time they are both online.
* **Clients run forever, keeping as much as possible.** Under real storage
  pressure (`navigator.storage.estimate()` ≥ 90% of quota) the client evicts
  **oldest-first** down to 75%, advancing a per-conversation "horizon" so evicted
  messages don't re-appear. Eviction is a *local forget* — it never issues a Gun
  graph delete, so it can't erase a message from anyone else.
* **The relay is a discovery point + live forwarder** and nothing more — it
  stores no messages and only ever sees ciphertext. Losing it never loses
  messages participants hold. Because it is stateless, the *server* also runs
  forever and can never remove a message erroneously: it holds none.

#### Message keys & delivery acks (forward infrastructure)

Messages are written under **time-ordered keys** (`<padded-ts>-<rand>`) so any
retention layer can range-prune by age without decrypting. Each reader publishes
a tiny **signed watermark** (`acks/<scope>/<pub> = {upTo, w}`) confirming it has
durably received a conversation up to a timestamp. These let a future server-side
archive reclaim space safely (drop only what everyone has).

#### Server-side store-and-forward — measured limitation

There is a built, unit-verified server **archivist + janitor**
(`server/archivist.js`): an always-on subscriber that would durably retain
messages and forget old ones safely (grace-TTL + acks + size cap, pruning *its
own* log only — never a graph delete). It is **off by default** (`XNET_ARCHIVIST=1`
to enable) because of a measured Gun `0.2020.x` limitation: a **Node** Gun peer
does not receive relayed messages over websocket here (node↔relay↔node graph
sync doesn't propagate; only browsers sync through the relay; node peers only
synced via LAN multicast, which clouds lack). So the archivist can't capture in
production today. The janitor logic is correct and tested for the day that
changes. Consequence: **store-and-forward to a recipient who is offline at send
time isn't guaranteed** — delivery happens when sender and recipient are next
online at overlapping moments (directly or via any other online participant).

### What an observer can and cannot see

Cannot: message contents, file contents, room names, your contact list contents.
Everything stored in Gun is ciphertext.

Can (documented metadata leaks — see `public/js/db.js`):
* The **username directory** maps usernames to public keys (the chosen trade-off
  for easy discovery). Don't register a username you don't want linked to you.
* Message **timestamps** and the **graph shape** (which conversation ids and room
  ids are active) are visible, since they're needed for ordering and routing.
* To harden: drop the directory and add contacts by share-link/QR instead.

## Deploy (one click-ish)

### Docker
```bash
docker build -t xnet .
docker run -p 8765:8765 -v xnet-data:/app/data xnet
```

Optional env: `PORT`, `GUN_DATA`. Experimental retention (off by default; see the
limitation above): `XNET_ARCHIVIST=1`, `XNET_GRACE_MS`, `XNET_MAX_RECORDS`,
`XNET_JANITOR_MS`.

### GitHub Actions (build & publish)
`.github/workflows/docker.yml` builds the image on every push/PR and publishes it
to **GHCR** (`ghcr.io/<owner>/xnet`) on pushes to `main` and `v*` tags — no setup
needed (uses the built-in `GITHUB_TOKEN`). PRs build only. Pull and run:
```bash
docker run -p 8765:8765 -v xnet-data:/app/data ghcr.io/<owner>/xnet:latest
```

### Render.com
Push this repo to GitHub → Render → **New + → Blueprint** → pick the repo.
`render.yaml` provisions the web service and a 1 GB disk automatically.

Any host that can run a Dockerfile (Railway, Fly.io, Koyeb, a VPS) works the same
way: it's one container exposing one port.

## Project layout

```
server/server.js     Node: serves the SPA + hosts the Gun relay at /gun
server/archivist.js  Server retention + janitor (opt-in; see limitation above)
public/index.html    SPA shell
public/js/crypto.js  SEA wrappers (the whole crypto story, ~120 lines)
public/js/db.js      Gun graph: identity, directory, contacts, DMs, rooms
public/js/markdown.js  tiny safe Markdown renderer
public/js/app.js     UI + wiring
public/sw.js         service worker (offline boot)
```
