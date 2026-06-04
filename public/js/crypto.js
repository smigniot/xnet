// crypto.js
// ---------
// Thin, auditable wrappers around Gun's SEA primitives. The whole privacy
// story of Xnet lives in this file, so it is deliberately small.
//
// Primitives used:
//   - SEA.pair()                    asymmetric keypair {pub, priv, epub, epriv}
//   - SEA.secret(theirEpub, myPair) ECDH shared secret (same value both ways)
//   - SEA.encrypt / SEA.decrypt     symmetric AES with a key or a pair
//   - SEA.sign / SEA.verify         detached authenticity over a payload
//   - SEA.work(...SHA-256)          deterministic hashing (conversation ids)
//
// Threat model in one line: the relay and anyone sniffing the wire see only
// ciphertext + public keys + timestamps. They cannot read content, and they
// cannot forge a message as you (every message is signed by its author).

const SEA = window.SEA;

export async function newPair() {
  return SEA.pair();
}

// Deterministic id shared by exactly two participants, independent of order.
export async function conversationId(pubA, pubB) {
  const [a, b] = [pubA, pubB].sort();
  const hash = await SEA.work(a + '|' + b, null, null, { name: 'SHA-256' });
  // Keep it filesystem/graph-key friendly.
  return 'dm_' + hash.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
}

// Random long-term symmetric key for a shared room.
export async function newRoomKey() {
  // 32 bytes of randomness, base64 — used directly as a SEA symmetric key.
  return SEA.random(32).toString('base64');
}

// --- One-on-one (ECDH) -----------------------------------------------------

// Sign `payload` as me, then encrypt the signed blob to the shared secret so
// only the two of us can read it AND the reader can prove I wrote it.
// (SEA serializes objects itself, so we pass/return objects directly.)
export async function sealDM(payload, theirEpub, myPair) {
  const secret = await SEA.secret(theirEpub, myPair);
  const signed = await SEA.sign(payload, myPair);
  return SEA.encrypt(signed, secret);
}

// Decrypt + verify. Returns the payload or null if it can't be trusted.
export async function openDM(ciphertext, fromPub, theirEpub, myPair) {
  try {
    const secret = await SEA.secret(theirEpub, myPair);
    const signed = await SEA.decrypt(ciphertext, secret);
    if (signed == null) return null;
    const payload = await SEA.verify(signed, fromPub);
    return payload == null ? null : payload;
  } catch {
    return null;
  }
}

// --- Shared rooms (symmetric key) -----------------------------------------

export async function sealRoom(payload, roomKey, myPair) {
  const signed = await SEA.sign(payload, myPair);
  return SEA.encrypt(signed, roomKey);
}

export async function openRoom(ciphertext, fromPub, roomKey) {
  try {
    const signed = await SEA.decrypt(ciphertext, roomKey);
    if (signed == null) return null;
    const payload = await SEA.verify(signed, fromPub);
    return payload == null ? null : payload;
  } catch {
    return null;
  }
}

// --- Signed, public claims (e.g. ack watermarks) ---------------------------

// Sign a small object so anyone (including the relay) can verify I authored it.
export async function signClaim(obj, myPair) {
  return SEA.sign(obj, myPair);
}

// Returns the signed object if the signature matches `pub`, else null.
export async function verifyClaim(signed, pub) {
  try {
    const obj = await SEA.verify(signed, pub);
    return obj == null ? null : obj;
  } catch {
    return null;
  }
}

// --- Encrypt-to-self (store a secret only I can read) ----------------------

export async function sealToSelf(data, myPair) {
  return SEA.encrypt(data, myPair);
}

export async function openFromSelf(ciphertext, myPair) {
  try {
    const data = await SEA.decrypt(ciphertext, myPair);
    return data == null ? null : data;
  } catch {
    return null;
  }
}
