/**
 * EO Assistant mobile PWA.
 *
 * Stage 1: QR bind, one E2EE text conversation per desktop, presence, local
 * archive. Stage 2 file/voice/PPT transport reuses the same envelope `kind` and
 * `meta` fields; the relay never parses them.
 */
import jsQR from 'jsqr'
import {
  aesDecrypt, aesEncrypt, b64u, canonicalEnvelope, createIdentity, envelopeAad,
  fromB64u, newMessageId, sharedKey, sign, verify,
} from './crypto.js'
import {
  getBind, normalizeRelay, parseBindPayload, signedRequest, wsUrl,
} from './api.js'

const STORE_KEY = 'eo.state.v1'
const MAX_MESSAGES = 300
const HEARTBEAT_MS = 20_000
const STALE_MS = 55_000
const MAX_BACKOFF_MS = 30_000

const $ = id => document.getElementById(id)
const listView = $('listView')
const chatView = $('chatView')
const messagesEl = $('messages')
const textInput = $('textInput')

const state = {
  identity: null,
  relay: '',
  conversations: [],
}

const links = new Map()
let activeId = null
let toastTimer = null
let scanStream = null
let scanTimer = null
let codeResolver = null

function secureStore() {
  return typeof window.EoSecure?.get === 'function' ? window.EoSecure : null
}

function readSaved() {
  try {
    const secure = secureStore()
    const raw = secure ? secure.get(STORE_KEY) : localStorage.getItem(STORE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveState() {
  try {
    for (const conv of state.conversations) {
      if (Array.isArray(conv.messages) && conv.messages.length > MAX_MESSAGES) {
        conv.messages = conv.messages.slice(-MAX_MESSAGES)
      }
    }
    const raw = JSON.stringify({ v: 1, relay: state.relay, conversations: state.conversations })
    const secure = secureStore()
    if (secure) secure.put(STORE_KEY, raw)
    else localStorage.setItem(STORE_KEY, raw)
  } catch (error) {
    toast(`本地保存失败：${error.message || error}`)
  }
}

function toast(text) {
  const el = $('toast')
  el.textContent = String(text)
  el.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 2600)
}

function fmtTime(ts) {
  if (!ts) return ''
  const date = new Date(ts)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function titleOf(conv) {
  return conv.title || 'EO助手'
}

function activeConv() {
  return state.conversations.find(conv => conv.convId === activeId) || null
}

function convByMsgId(msgId) {
  for (const conv of state.conversations) {
    const message = (conv.messages || []).find(item => item.msgId === msgId)
    if (message) return { conv, message }
  }
  return null
}

function upsertConversation(conv) {
  const existing = state.conversations.find(item => item.convId === conv.convId)
  if (!existing) {
    state.conversations.unshift(conv)
    return conv
  }
  Object.assign(existing, {
    ...conv,
    messages: existing.messages?.length ? existing.messages : (conv.messages || []),
    unread: existing.unread || 0,
  })
  return existing
}

/* ------------------------------------------------------------------ links */

function ensureLink(relay) {
  let normalized
  try { normalized = normalizeRelay(relay) } catch (error) { toast(error.message); return null }
  const existing = links.get(normalized)
  if (existing) {
    if (!existing.ws || existing.ws.readyState > 1) connectLink(existing)
    return existing
  }
  const link = {
    relay: normalized,
    ws: null,
    connected: false,
    reconnectTimer: null,
    heartbeat: null,
    lastPong: 0,
    backoff: 1000,
    queue: [],
  }
  links.set(normalized, link)
  connectLink(link)
  return link
}

function connectLink(link) {
  if (!state.identity) return
  if (link.ws && link.ws.readyState <= 1) return
  if (link.reconnectTimer) { clearTimeout(link.reconnectTimer); link.reconnectTimer = null }
  let socket
  try {
    socket = new WebSocket(wsUrl(state.identity, link.relay))
  } catch (error) {
    scheduleReconnect(link)
    return
  }
  link.ws = socket

  socket.onopen = () => {
    link.connected = true
    link.backoff = 1000
    link.lastPong = Date.now()
    if (link.heartbeat) clearInterval(link.heartbeat)
    link.heartbeat = setInterval(() => heartbeat(link), HEARTBEAT_MS)
    const queued = link.queue
    link.queue = []
    for (const frame of queued) {
      if (socket.readyState === 1) socket.send(JSON.stringify(frame))
      else link.queue.push(frame)
    }
    render()
  }

  socket.onmessage = (event) => {
    let frame
    try { frame = JSON.parse(String(event.data)) } catch { return }
    link.lastPong = Date.now()
    handleFrame(link, frame)
  }

  socket.onclose = () => {
    link.connected = false
    if (link.heartbeat) clearInterval(link.heartbeat)
    link.heartbeat = null
    for (const conv of state.conversations) {
      if (conv.relay === link.relay) conv.online = false
    }
    render()
    scheduleReconnect(link)
  }

  socket.onerror = () => { /* close handles retry */ }
}

function scheduleReconnect(link) {
  if (link.reconnectTimer) return
  const delay = link.backoff + Math.floor(Math.random() * 500)
  link.backoff = Math.min(Math.round(link.backoff * 1.8), MAX_BACKOFF_MS)
  link.reconnectTimer = setTimeout(() => {
    link.reconnectTimer = null
    connectLink(link)
  }, delay)
}

function heartbeat(link) {
  if (!link.ws || link.ws.readyState !== 1) return
  if (Date.now() - link.lastPong > STALE_MS) {
    try { link.ws.close() } catch { /* ignore */ }
    return
  }
  link.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
}

function sendFrame(relay, frame) {
  const link = ensureLink(relay)
  if (!link) return false
  if (link.ws && link.ws.readyState === 1) {
    link.ws.send(JSON.stringify(frame))
    return true
  }
  if (link.queue.length < 100) link.queue.push(frame)
  return false
}

async function handleFrame(link, frame) {
  switch (frame.type) {
    case 'hello':
      link.connected = true
      render()
      break
    case 'pong':
      break
    case 'presence': {
      const conv = state.conversations.find(item => item.convId === frame.convId && item.relay === link.relay)
      if (!conv) break
      conv.online = Boolean(frame.online)
      conv.lastSeenAt = frame.ts || Date.now()
      saveState()
      if (conv.convId === activeId) renderChat()
      renderList()
      break
    }
    case 'msg':
      await handleIncoming(link, frame.envelope)
      break
    case 'ack': {
      const hit = convByMsgId(frame.msgId)
      if (hit) {
        hit.message.status = 'sent'
        saveState()
        if (hit.conv.convId === activeId) renderChat()
      }
      break
    }
    case 'error': {
      if (frame.msgId) {
        const hit = convByMsgId(frame.msgId)
        if (hit) {
          hit.message.status = 'failed'
          saveState()
          if (hit.conv.convId === activeId) renderChat()
        }
      }
      toast(frame.error || 'relay 拒绝了请求')
      break
    }
    default:
      break
  }
}

async function handleIncoming(link, envelope) {
  if (!envelope) return
  const conv = state.conversations.find(item => item.convId === envelope.convId && item.relay === link.relay)
  if (!conv) return
  if (envelope.sender !== conv.peerDeviceId) return
  if ((conv.messages || []).some(message => message.msgId === envelope.msgId)) return
  if (!verify(canonicalEnvelope(envelope), envelope.sig, conv.peerEdPub)) {
    toast('收到一条签名无效的消息，已丢弃')
    return
  }
  let payload
  try {
    const plain = await aesDecrypt(fromB64u(conv.key), envelope.nonce, envelope.ct, envelopeAad(envelope))
    payload = JSON.parse(plain)
  } catch {
    toast('消息解密失败，已丢弃')
    return
  }
  const message = {
    msgId: envelope.msgId,
    seq: envelope.seq,
    sender: envelope.sender,
    kind: envelope.kind,
    ts: envelope.ts,
    text: String(payload.text ?? ''),
    meta: payload.meta ?? null,
    status: 'received',
  }
  if (!Array.isArray(conv.messages)) conv.messages = []
  conv.messages.push(message)
  conv.seq = Math.max(Number(conv.seq || 0), Number(envelope.seq) || 0)
  conv.lastMessageAt = envelope.ts
  conv.online = true
  if (activeId !== conv.convId) conv.unread = Number(conv.unread || 0) + 1
  saveState()
  renderList()
  if (activeId === conv.convId) renderChat()
}

/* --------------------------------------------------------------- bind flow */

async function beginBind(payload) {
  const relay = normalizeRelay(payload.relay)
  const info = await getBind(relay, payload.bindId)
  if (info.desktopXPub !== payload.desktopXPub) throw new Error('二维码公钥与 relay 返回不一致')
  if (info.nonce !== payload.nonce) throw new Error('二维码已过期，请在电脑上重新生成')
  if (info.status === 'expired') throw new Error('二维码已过期，请在电脑上重新生成')
  if (info.status === 'confirmed') throw new Error('这个二维码已经被使用')

  await signedRequest(state.identity, relay, 'POST', `/v1/bind/${encodeURIComponent(payload.bindId)}/claim`, {
    edPub: state.identity.edPub,
    xPub: state.identity.xPub,
    nonce: payload.nonce,
  })

  const code = await askCode()
  if (!code) return

  const result = await signedRequest(state.identity, relay, 'POST', `/v1/bind/${encodeURIComponent(payload.bindId)}/confirm`, { code })
  const key = await sharedKey(state.identity.xPriv, result.peerXPub, result.convId)
  const conv = upsertConversation({
    convId: result.convId,
    title: payload.name || 'EO助手',
    peerDeviceId: result.peerDeviceId,
    peerEdPub: result.peerEdPub,
    peerXPub: result.peerXPub,
    key: b64u(key),
    seq: Number(result.seq || 0),
    relay,
    online: false,
    unread: 0,
    createdAt: Date.now(),
    lastMessageAt: null,
    messages: [],
  })
  state.relay = relay
  saveState()
  ensureLink(relay)
  render()
  openChat(conv.convId)
  toast('已连接电脑版 EO助手')
}

function askCode() {
  return new Promise((resolve) => {
    codeResolver = resolve
    $('codeError').hidden = true
    $('codeInput').value = ''
    $('codeModal').hidden = false
    setTimeout(() => $('codeInput').focus(), 60)
  })
}

function finishCode(value) {
  $('codeModal').hidden = true
  const resolve = codeResolver
  codeResolver = null
  if (resolve) resolve(value)
}

/* ------------------------------------------------------------------ scanner */

async function openScanner() {
  $('scanModal').hidden = false
  $('scanError').hidden = true
  $('bindLink').value = ''
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
    const video = $('scanVideo')
    video.srcObject = scanStream
    await video.play()
    scanTimer = setInterval(scanFrame, 220)
  } catch (error) {
    showScanError(`无法打开相机：${error.message || error}。可在下方粘贴二维码链接。`)
  }
}

function showScanError(text) {
  const el = $('scanError')
  el.textContent = text
  el.hidden = false
}

function stopScanner() {
  if (scanTimer) clearInterval(scanTimer)
  scanTimer = null
  if (scanStream) {
    for (const track of scanStream.getTracks()) track.stop()
    scanStream = null
  }
  const video = $('scanVideo')
  if (video) video.srcObject = null
}

function scanFrame() {
  const video = $('scanVideo')
  const canvas = $('scanCanvas')
  if (!video || !canvas || video.readyState < 2 || !video.videoWidth) return
  const width = Math.min(640, video.videoWidth)
  const height = Math.round((video.videoHeight / video.videoWidth) * width)
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(video, 0, 0, width, height)
  const image = context.getImageData(0, 0, width, height)
  const code = jsQR(image.data, width, height, { inversionAttempts: 'dontInvert' })
  if (!code?.data) return
  if (!String(code.data).startsWith('eo://bind')) return
  stopScanner()
  $('scanModal').hidden = true
  handleBindText(code.data)
}

async function handleBindText(text) {
  try {
    const payload = parseBindPayload(text)
    await beginBind(payload)
  } catch (error) {
    toast(error.message || String(error))
  }
}

/* ---------------------------------------------------------------------- ui */

function render() {
  renderList()
  if (activeId) renderChat()
  if (!$('settingsModal').hidden) renderSettings()
}

function renderList() {
  listView.replaceChildren()
  if (!state.conversations.length) {
    const node = $('emptyTpl').content.cloneNode(true)
    const button = node.querySelector('[data-action="scan"]')
    if (button) button.addEventListener('click', openScanner)
    listView.append(node)
    return
  }
  const sorted = [...state.conversations].sort((a, b) => (b.lastMessageAt || b.createdAt || 0) - (a.lastMessageAt || a.createdAt || 0))
  for (const conv of sorted) {
    const card = document.createElement('div')
    card.className = 'chatcard'
    card.addEventListener('click', () => openChat(conv.convId))

    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    avatar.textContent = titleOf(conv).slice(0, 1).toUpperCase()
    const presence = document.createElement('span')
    presence.className = `presence${conv.online ? ' on' : ''}`
    avatar.append(presence)

    const meta = document.createElement('div')
    meta.className = 'chatmeta'
    const row = document.createElement('div')
    row.className = 'chatrow'
    const name = document.createElement('div')
    name.className = 'chatname'
    name.textContent = titleOf(conv)
    const time = document.createElement('div')
    time.className = 'chattime'
    time.textContent = fmtTime(conv.lastMessageAt)
    row.append(name, time)

    const snippets = document.createElement('div')
    snippets.className = 'chatrow'
    const snippet = document.createElement('div')
    snippet.className = 'snippet'
    const last = (conv.messages || [])[conv.messages.length - 1]
    snippet.textContent = last ? (last.kind === 'text' ? last.text : `[${last.kind}]`) : '已连接，可以发消息'
    snippets.append(snippet)
    if (conv.unread > 0) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = String(conv.unread)
      snippets.append(badge)
    }
    meta.append(row, snippets)
    card.append(avatar, meta)
    listView.append(card)
  }
}

function renderChat() {
  const conv = activeConv()
  if (!conv) return
  $('chatAvatar').textContent = titleOf(conv).slice(0, 1).toUpperCase()
  $('chatName').textContent = titleOf(conv)
  const status = $('chatStatus')
  status.replaceChildren()
  const dot = document.createElement('span')
  dot.className = `dot${conv.online ? ' on' : ''}`
  const text = document.createElement('span')
  text.textContent = conv.online ? '在线' : '离线'
  status.append(dot, text)

  messagesEl.replaceChildren()
  for (const message of conv.messages || []) {
    const bubble = document.createElement('div')
    bubble.className = `bubble${message.sender === state.identity.deviceId ? ' mine' : ''}`
    const body = document.createElement('div')
    body.textContent = message.kind === 'text' ? message.text : `[${message.kind}] 阶段 2 接入`
    const meta = document.createElement('span')
    meta.className = 'meta'
    const statusText = message.sender === state.identity.deviceId
      ? (message.status === 'sending' ? '发送中' : message.status === 'failed' ? '失败' : '已发送')
      : ''
    meta.textContent = [fmtTime(message.ts), statusText].filter(Boolean).join(' · ')
    bubble.append(body, meta)
    messagesEl.append(bubble)
  }
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function openChat(convId) {
  activeId = convId
  const conv = activeConv()
  if (conv) {
    conv.unread = 0
    saveState()
  }
  chatView.hidden = false
  listView.hidden = true
  renderChat()
}

function closeChat() {
  activeId = null
  chatView.hidden = true
  listView.hidden = false
  renderList()
}

function renderSettings() {
  $('deviceId').textContent = state.identity?.deviceId || '—'
  $('relayInput').value = state.relay || ''
  const connected = [...links.values()].some(link => link.connected)
  $('linkState').textContent = connected ? '已连接 relay' : (state.relay ? '连接中 / 未连接' : '未配置')
}

/* ------------------------------------------------------------------- send */

async function sendText() {
  const conv = activeConv()
  const text = textInput.value.trim()
  if (!conv || !text) return
  textInput.value = ''
  const seq = Math.max(Number(conv.seq || 0), 0) + 1
  conv.seq = seq
  const envelope = {
    v: 1,
    convId: conv.convId,
    msgId: newMessageId(),
    seq,
    kind: 'text',
    sender: state.identity.deviceId,
    ts: Date.now(),
    nonce: '',
    ct: '',
    meta: null,
  }
  try {
    const encrypted = await aesEncrypt(fromB64u(conv.key), JSON.stringify({ text, meta: null }), envelopeAad(envelope))
    envelope.nonce = encrypted.nonce
    envelope.ct = encrypted.ct
    envelope.sig = b64u(sign(canonicalEnvelope(envelope), state.identity.edPriv))
  } catch (error) {
    toast(`加密失败：${error.message || error}`)
    return
  }
  if (!Array.isArray(conv.messages)) conv.messages = []
  conv.messages.push({
    msgId: envelope.msgId,
    seq,
    sender: state.identity.deviceId,
    kind: 'text',
    ts: envelope.ts,
    text,
    meta: null,
    status: 'sending',
  })
  conv.lastMessageAt = envelope.ts
  sendFrame(conv.relay, { type: 'msg', envelope })
  saveState()
  renderChat()
  renderList()
}

/* ---------------------------------------------------------------- settings */

function openSettings() {
  renderSettings()
  $('settingsModal').hidden = false
}

function saveRelay() {
  try {
    state.relay = normalizeRelay($('relayInput').value)
    saveState()
    ensureLink(state.relay)
    $('settingsModal').hidden = true
    toast('relay 地址已保存')
    render()
  } catch (error) {
    toast(error.message)
  }
}

function resetAll() {
  const ok = window.confirm('将删除本机设备私钥和全部对话，电脑端需要重新扫码。继续？')
  if (!ok) return
  for (const link of links.values()) {
    try { link.ws?.close() } catch { /* ignore */ }
  }
  const secure = secureStore()
  if (secure) {
    if (typeof secure.delete === 'function') secure.delete(STORE_KEY)
    else secure.put(STORE_KEY, '')
  } else {
    localStorage.removeItem(STORE_KEY)
  }
  location.reload()
}

/* ------------------------------------------------------------------- init */

async function init() {
  const saved = readSaved()
  if (saved?.identity?.deviceId) {
    state.identity = saved.identity
  } else {
    state.identity = await createIdentity()
  }
  state.relay = saved?.relay ? String(saved.relay) : ''
  state.conversations = Array.isArray(saved?.conversations) ? saved.conversations : []
  for (const conv of state.conversations) {
    conv.messages = Array.isArray(conv.messages) ? conv.messages : []
    conv.online = false
    conv.relay = conv.relay || state.relay
    conv.seq = Number(conv.seq || 0)
    conv.unread = Number(conv.unread || 0)
  }
  saveState()
  render()

  const relays = new Set([state.relay, ...state.conversations.map(conv => conv.relay)].filter(Boolean))
  for (const relay of relays) ensureLink(relay)
}

/* --------------------------------------------------------------- listeners */

$('scanBtn').addEventListener('click', openScanner)
$('scanClose').addEventListener('click', () => {
  stopScanner()
  $('scanModal').hidden = true
})
$('bindLinkBtn').addEventListener('click', async () => {
  const text = $('bindLink').value.trim()
  if (!text) return
  stopScanner()
  $('scanModal').hidden = true
  await handleBindText(text)
})
$('backBtn').addEventListener('click', closeChat)
$('sendBtn').addEventListener('click', sendText)
textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    sendText()
  }
})
$('attachBtn').addEventListener('click', () => toast('文件发送在阶段 2 接入'))
$('codeBtn').addEventListener('click', () => {
  const value = $('codeInput').value.trim()
  if (!/^\d{6}$/.test(value)) {
    $('codeError').textContent = '请输入 6 位数字确认码'
    $('codeError').hidden = false
    return
  }
  finishCode(value)
})
$('codeClose').addEventListener('click', () => finishCode(null))
$('codeInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('codeBtn').click()
})
$('settingsBtn').addEventListener('click', openSettings)
$('settingsClose').addEventListener('click', () => { $('settingsModal').hidden = true })
$('relaySave').addEventListener('click', saveRelay)
$('openBindHelp').addEventListener('click', () => {
  $('settingsModal').hidden = true
  openScanner()
})
$('resetBtn').addEventListener('click', resetAll)

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    for (const link of links.values()) if (!link.connected) connectLink(link)
  }
})

init().catch((error) => {
  console.error(error)
  toast(`初始化失败：${error.message || error}`)
})
