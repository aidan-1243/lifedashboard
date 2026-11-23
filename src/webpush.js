// Web Push (Life's own notifications) using only Web Crypto.
//   RFC 8291: message encryption (aes128gcm)   RFC 8292: VAPID sign-in to the push service
// Apple, Google and Mozilla run the push services; they only ever see encrypted bytes.

const enc = new TextEncoder();
export const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '=')), (c) => c.charCodeAt(0)),
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// Encrypt `payload` (bytes) for one subscription. `fixed` is only for tests (known keys and salt).
export async function encryptPayload(sub, payload, fixed = {}) {
  const uaPublic = b64u.dec(sub.p256dh);
  const authSecret = b64u.dec(sub.auth);
  const asKeys = fixed.asKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = fixed.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// VAPID: a short-lived token signed with our private key, scoped to the push service's origin.
const vapidCache = new Map();
async function vapidHeader(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const hit = vapidCache.get(aud);
  if (hit && hit.exp - 600 > Date.now() / 1000) return hit.header;
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u.enc(enc.encode(JSON.stringify({ aud, exp, sub: env.VAPID_SUBJECT || env.PUBLIC_URL })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`));
  const header = `vapid t=${head}.${body}.${b64u.enc(sig)}, k=${env.VAPID_PUBLIC}`;
  vapidCache.set(aud, { exp, header });
  return header;
}

// Send one notification to one device. Returns { ok, status, gone, error }.
export async function sendWebPush(env, sub, message, { urgency = 'normal', ttl = 6 * 3600, topic } = {}) {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(message)));
  const headers = {
    authorization: await vapidHeader(sub.endpoint, env),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(ttl),
    urgency,
  };
  if (topic) headers.topic = topic; // a newer message with the same topic replaces an undelivered older one
  const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
  if (res.ok) return { ok: true, status: res.status };
  const text = (await res.text().catch(() => '')).slice(0, 200);
  return { ok: false, status: res.status, gone: res.status === 404 || res.status === 410, error: `${res.status} ${text}`.trim() };
}
