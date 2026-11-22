/**
 * End-to-end relay test: desktop + phone identities, QR claim/confirm, E2EE
 * text in both directions, presence, history, duplicate handling, bad auth.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import { deriveDeviceId, edPublicFromRaw, verifyEd25519 } from '../src/auth.js'
import { base64url, canonicalEnvelope, envelopeAad, sha256hex } from '../src/protocol.js'
import { createRelay } from '../src/server.js'

const ED_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const X_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const IV = 12
const TAG = 16

function makeDevice() {
  const ed = crypto.generateKeyPairSync('ed25519')
  const x = crypto.generateKeyPairSync('x25519')
  const edSpki = ed.publicKey.export({ format: 'der', type: 'spki' })
  const xSpki = x.publicKey.export({ format: 'der', type: 'spki' })
  const edRaw = edSpki.subarray(ED_PREFIX.length)
  const xRaw = xSpki.subarray(X_PREFIX.length)
  return {
    ed, x,
    edRaw, xRaw,
    edPub: base64url(edRaw),
    xPub: base64url(xRaw),
    deviceId: deriveDeviceId(edRaw),
  }
}

function restHeaders(device, method, pathname, body) {
  const ts = String(Date.now())
  const canonical = `${method}\n${pathname}\n${ts}\n${sha256hex(body)}`
  return {
    'content-type': 'application/json',
    'x-eo-device': device.deviceId,
    'x-eo-ts': ts,
    'x-eo-sig': base64url(crypto.sign(null, Buffer.from(canonical), device.ed.privateKey)),
    'x-eo-ed': device.edPub,
    'x-eo-x': device.xPub,
  }
}

async function api(base, device, method, pathname, body) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const signPath = pathname.split('?')[0]
  const res = await fetch(base + pathname, {
    method,
    headers: restHeaders(device, method, signPath, raw),
    body: raw || undefined,
  })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { error: text } }
  return { status: res.status, data }
}

function wsUrl(base, device) {
  const ts = String(Date.now())
  const canonical = `ws\n${device.deviceId}\n${ts}`
  const params = new URLSearchParams({
    deviceId: device.deviceId,
    ts,
    ed: device.edPub,
    x: device.xPub,
    sig: base64url(crypto.sign(null, Buffer.from(canonical), device.ed.privateKey)),
  })
  return `${base.replace('http:', 'ws:')}/v1/ws?${params}`
}

function connect(base, device) {
  const ws = new WebSocket(wsUrl(base, device))
  ws.frames = []
  ws.on('message', (data) => {
    try { ws.frames.push(JSON.parse(String(data))) } catch { /* ignore */ }
  })
  ws.on('error', () => {})
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

async function nextFrame(ws, predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const index = ws.frames.findIndex(predicate)
    if (index >= 0) return ws.frames.splice(index, 1)[0]
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for frame; have ${JSON.stringify(ws.frames.map(f => f.type))}`)
}

function sharedKey(device, peerXPub, convId) {
  const peer = crypto.createPublicKey({
    key: Buffer.concat([X_PREFIX, Buffer.from(peerXPub, 'base64url')]),
    format: 'der', type: 'spki',
  })
  const secret = crypto.diffieHellman({ privateKey: device.x.privateKey, publicKey: peer })
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(convId), Buffer.from('eo-conv-v1'), 32))
}

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(IV)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  return { nonce: base64url(iv), ct: base64url(Buffer.concat([body, tag])) }
}

function decrypt(key, nonce, ct, aad) {
  const iv = Buffer.from(nonce, 'base64url')
  const payload = Buffer.from(ct, 'base64url')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(payload.subarray(payload.length - TAG))
  return Buffer.concat([decipher.update(payload.subarray(0, payload.length - TAG)), decipher.final()]).toString('utf8')
}

function makeEnvelope(device, convId, seq, text, key) {
  const envelope = {
    v: 1, convId, msgId: `m_${crypto.randomBytes(8).toString('hex')}`, seq,
    kind: 'text', sender: device.deviceId, ts: Date.now(),
    nonce: '', ct: '', meta: null,
  }
  const encrypted = encrypt(key, JSON.stringify({ text, meta: null }), envelopeAad(envelope))
  envelope.nonce = encrypted.nonce
  envelope.ct = encrypted.ct
  envelope.sig = base64url(crypto.sign(null, Buffer.from(canonicalEnvelope(envelope)), device.ed.privateKey))
  return envelope
}

test('bind, E2EE chat, presence, history, duplicate and bad auth', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-relay-test-'))
  const relay = createRelay({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(dir, 'relay.sqlite'),
    publicDir: path.join(dir, 'public'),
  })
  const { port } = await relay.start()
  const base = `http://127.0.0.1:${port}`
  const desktop = makeDevice()
  const phone = makeDevice()

  try {
    const desktopWs = await connect(base, desktop)
    const hello = await nextFrame(desktopWs, f => f.type === 'hello')
    assert.equal(hello.deviceId, desktop.deviceId)

    const created = await api(base, desktop, 'POST', '/v1/bind/create', {
      xPub: desktop.xPub,
      fingerprint: desktop.deviceId.slice(-8),
    })
    assert.equal(created.status, 200, JSON.stringify(created.data))
    assert.ok(created.data.bindId)
    assert.ok(created.data.nonce)

    const publicBind = await fetch(`${base}/v1/bind/${created.data.bindId}`)
    assert.equal(publicBind.status, 200)
    const bindInfo = await publicBind.json()
    assert.equal(bindInfo.desktopXPub, desktop.xPub)
    assert.equal(bindInfo.nonce, created.data.nonce)
    assert.equal(bindInfo.status, 'waiting')

    const claimed = await api(base, phone, 'POST', `/v1/bind/${created.data.bindId}/claim`, {
      edPub: phone.edPub,
      xPub: phone.xPub,
      nonce: created.data.nonce,
    })
    assert.equal(claimed.status, 200, JSON.stringify(claimed.data))
    const claimedFrame = await nextFrame(desktopWs, f => f.type === 'bind/claimed')
    assert.match(claimedFrame.code, /^\d{6}$/)

    const confirmed = await api(base, phone, 'POST', `/v1/bind/${created.data.bindId}/confirm`, {
      code: claimedFrame.code,
    })
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data))
    assert.equal(confirmed.data.peerDeviceId, desktop.deviceId)
    assert.equal(confirmed.data.peerXPub, desktop.xPub)
    const confirmedFrame = await nextFrame(desktopWs, f => f.type === 'bind/confirmed')
    assert.equal(confirmedFrame.convId, confirmed.data.convId)
    assert.equal(confirmedFrame.peerDeviceId, phone.deviceId)

    const convId = confirmed.data.convId
    const phoneWs = await connect(base, phone)
    await nextFrame(desktopWs, f => f.type === 'presence' && f.convId === convId && f.online === true)
    await nextFrame(phoneWs, f => f.type === 'presence' && f.convId === convId && f.online === true)

    const phoneKey = sharedKey(phone, desktop.xPub, convId)
    const desktopKey = sharedKey(desktop, phone.xPub, convId)
    assert.deepEqual(phoneKey, desktopKey)

    const phoneMessage = makeEnvelope(phone, convId, 1, '你好，桌面端', phoneKey)
    phoneWs.send(JSON.stringify({ type: 'msg', envelope: phoneMessage }))
    const inbound = await nextFrame(desktopWs, f => f.type === 'msg' && f.envelope.msgId === phoneMessage.msgId)
    assert.equal(decrypt(desktopKey, inbound.envelope.nonce, inbound.envelope.ct, envelopeAad(inbound.envelope)),
      JSON.stringify({ text: '你好，桌面端', meta: null }))
    assert.ok(verifyEd25519(canonicalEnvelope(inbound.envelope), Buffer.from(inbound.envelope.sig, 'base64url'), phone.edRaw))
    await nextFrame(phoneWs, f => f.type === 'ack' && f.msgId === phoneMessage.msgId)

    const reply = makeEnvelope(desktop, convId, 2, '收到，手机端', desktopKey)
    desktopWs.send(JSON.stringify({ type: 'msg', envelope: reply }))
    const outbound = await nextFrame(phoneWs, f => f.type === 'msg' && f.envelope.msgId === reply.msgId)
    assert.equal(JSON.parse(decrypt(phoneKey, outbound.envelope.nonce, outbound.envelope.ct, envelopeAad(outbound.envelope))).text, '收到，手机端')

    // Duplicate frame: relay ACKs it but must not store or forward twice.
    phoneWs.send(JSON.stringify({ type: 'msg', envelope: phoneMessage }))
    const duplicateAck = await nextFrame(phoneWs, f => f.type === 'ack' && f.msgId === phoneMessage.msgId)
    assert.equal(duplicateAck.duplicate, true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(desktopWs.frames.filter(f => f.type === 'msg' && f.envelope.msgId === phoneMessage.msgId).length, 0)

    const history = await api(base, phone, 'GET', `/v1/history?convId=${convId}&after=0&limit=200`)
    assert.equal(history.status, 200, JSON.stringify(history.data))
    assert.equal(history.data.messages.length, 2)
    assert.equal(history.data.messages[0].msgId, phoneMessage.msgId)
    assert.equal(history.data.messages[1].msgId, reply.msgId)

    const tampered = {
      ...phoneMessage,
      msgId: `m_${crypto.randomBytes(8).toString('hex')}`,
      seq: 99,
      ct: phoneMessage.ct,
    }
    const bad = await api(base, phone, 'POST', '/v1/msg', { envelope: tampered })
    assert.equal(bad.status, 403)

    const badSig = { ...restHeaders(phone, 'GET', '/v1/history', ''), 'x-eo-sig': base64url(Buffer.alloc(64)) }
    const rejected = await fetch(`${base}/v1/history?convId=${convId}&after=0`, { headers: badSig })
    assert.equal(rejected.status, 401)

    desktopWs.close()
    phoneWs.close()
  } finally {
    await relay.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
