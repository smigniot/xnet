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

### Render.com
Push this repo to GitHub → Render → **New + → Blueprint** → pick the repo.
`render.yaml` provisions the web service and a 1 GB disk automatically.

Any host that can run a Dockerfile (Railway, Fly.io, Koyeb, a VPS) works the same
way: it's one container exposing one port.

## Project layout

```
server/server.js     Node: serves the SPA + hosts the Gun relay at /gun
public/index.html    SPA shell
public/js/crypto.js  SEA wrappers (the whole crypto story, ~120 lines)
public/js/db.js      Gun graph: identity, directory, contacts, DMs, rooms
public/js/markdown.js  tiny safe Markdown renderer
public/js/app.js     UI + wiring
public/sw.js         service worker (offline boot)
```
