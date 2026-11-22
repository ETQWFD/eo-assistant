/**
 * Mobile device identity + E2EE envelope helpers.
 *
 * Keys are generated locally with @noble/curves and never leave the phone in
 * plaintext. On Android the WebView wrapper exposes `window.EoSecure`, which
 * encrypts the state blob with an Android Keystore AES key; browsers fall back
 * to localStorage (documented risk, no server-side token involved).
 */
import { ed25519, x25519 } from '@noble/curves/ed25519'

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const te = new TextEncoder()

export function utf8(value) {
  return te.encode(String(value))
}

export function b64u(bytes) {
  let binary = ''
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function fromB64u(value) {
  const text = String(value).replace(/-/g, '+').replace(/_/g, '/')
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

export function randomBytes(length) {
  const out = new Uint8Array(length)
  crypto.getRandomValues(out)
  return out
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

export async function sha256hex(input) {
  const bytes = typeof input === 'string' ? utf8(input) : input
  const digest = await sha256(bytes)
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function base32(bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export async function deriveDeviceId(edPub) {
  const digest = await sha256(edPub)
  return `eo1_${base32(digest).slice(0, 16)}`
}

/** Generate a persistent anonymous device identity. */
export async function createIdentity() {
  const edPriv = randomBytes(32)
  const xPriv = randomBytes(32)
  const edPub = ed25519.getPublicKey(edPriv)
  const xPub = x25519.getPublicKey(xPriv)
  return {
    v: 1,
    deviceId: await deriveDeviceId(edPub),
    edPriv: b64u(edPriv),
    edPub: b64u(edPub),
    xPriv: b64u(xPriv),
    xPub: b64u(xPub),
    createdAt: Date.now(),
  }
}

export function sign(text, edPrivB64) {
  return ed25519.sign(utf8(text), fromB64u(edPrivB64))
}

export function verify(text, signatureB64, edPubB64) {
  try {
    return ed25519.verify(fromB64u(signatureB64), utf8(text), fromB64u(edPubB64))
  } catch {
    return false
  }
}

export async function hkdf(secret, salt, info, length = 32) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: utf8(salt),
    info: utf8(info),
  }, key, length * 8)
  return new Uint8Array(bits)
}

/** X25519 shared secret -> HKDF-SHA256, matching the DSH plugin. */
export async function sharedKey(xPrivB64, peerXPubB64, convId) {
  const secret = x25519.getSharedSecret(fromB64u(xPrivB64), fromB64u(peerXPubB64))
  return hkdf(secret, convId, 'eo-conv-v1', 32)
}

export async function aesEncrypt(keyBytes, plaintext, aad) {
  return aesEncryptBytes(keyBytes, utf8(plaintext), aad)
}

export async function aesEncryptBytes(keyBytes, bytes, aad) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  const iv = randomBytes(12)
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: utf8(aad),
    tagLength: 128,
  }, key, bytes)
  return { nonce: b64u(iv), ct: b64u(new Uint8Array(ciphertext)) }
}

export async function aesDecrypt(keyBytes, nonceB64, ctB64, aad) {
  const plain = await aesDecryptBytes(keyBytes, nonceB64, ctB64, aad)
  return new TextDecoder().decode(plain)
}

export async function aesDecryptBytes(keyBytes, nonceB64, ctB64, aad) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
  const plain = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: fromB64u(nonceB64),
    additionalData: utf8(aad),
    tagLength: 128,
  }, key, fromB64u(ctB64))
  return new Uint8Array(plain)
}

export function canonicalEnvelope(e) {
  return JSON.stringify([
    e.v, e.convId, e.msgId, e.seq, e.kind, e.sender, e.ts, e.nonce, e.ct, e.meta ?? null,
  ])
}

export function envelopeAad(e) {
  return `eo|${e.v}|${e.convId}|${e.msgId}|${e.seq}|${e.sender}|${e.ts}`
}

export function newMessageId() {
  return `m_${b64u(randomBytes(12))}`
}

export function newBlobId() {
  return `bl_${b64u(randomBytes(12))}`
}

export function newConvId() {
  return `c_${b64u(randomBytes(12))}`
}
