/**
 * EO Assistant mobile PWA.
 *
 * Stage 1: QR bind, one E2EE text conversation per desktop, presence, local
 * archive. Stage 2 file/voice/PPT transport reuses the same envelope `kind` and
 * `meta` fields; the relay never parses them.
 */
import jsQR from 'jsqr'
import {
  aesDecrypt, aesDecryptBytes, aesEncrypt, aesEncryptBytes, b64u, canonicalEnvelope,
  createIdentity, envelopeAad, fromB64u, newBlobId, newMessageId, sha256hex, sharedKey, sign, verify,
} from './crypto.js'
import {
  downloadBlob, getBind, getProfile, normalizeRelay, parseBindPayload, signedRequest, uploadBlob, wsUrl,
} from './api.js'

const STORE_KEY = 'eo.state.v1'
const MAX_MESSAGES = 300
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_VOICE_MS = 120_000
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
let recorder = null
let recordStream = null
let recordChunks = []
let recordStartedAt = 0
let recordTimer = null

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
    const conversations = state.conversations.map((conv) => ({
      ...conv,
      messages: (conv.messages || []).map((message) => {
        const { _objectUrl, _bytes, _loading, ...rest } = message
        return rest
      }),
    }))
    const raw = JSON.stringify({ v: 1, relay: state.relay, conversations })
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

function kindLabel(message) {
  const type = message.meta?.type || message.kind
  if (type === 'voice') return '语音'
  if (type === 'ppt') return 'PPT'
  if (type === 'image') return '图片'
  if (type === 'file') return '文件'
  return '消息'
}

function snippetOf(message) {
  if (!message) return ''
  if (message.kind === 'text' && !message.meta?.blobId) return message.text || ''
  const name = message.meta?.name || ''
  return `[${kindLabel(message)}] ${name}`.trim()
}

function avatarUrl(conv) {
  if (!conv?.iconBase64) return ''
  return `data:${conv.iconType || 'image/png'};base64,${conv.iconBase64}`
}

function paintAvatar(el, conv) {
  if (!el) return
  const url = avatarUrl(conv)
  el.textContent = ''
  if (url) {
    el.style.backgroundImage = `url("${url}")`
    el.style.backgroundSize = 'cover'
    el.style.backgroundPosition = 'center'
    el.classList.add('hasicon')
  } else {
    el.style.backgroundImage = ''
    el.classList.remove('hasicon')
    el.textContent = titleOf(conv).slice(0, 1).toUpperCase()
  }
}

function applyProfile(conv, profile) {
  if (!conv || !profile) return
  if (profile.name) conv.title = String(profile.name).slice(0, 32)
  conv.iconType = profile.iconType || ''
  conv.iconBase64 = profile.iconBase64 || ''
  conv.iconVersion = profile.updatedAt || conv.iconVersion || 0
}

async function refreshProfile(conv) {
  if (!conv?.peerDeviceId || !conv.relay) return
  try {
    const profile = await getProfile(conv.relay, conv.peerDeviceId)
    if (!profile) return
    applyProfile(conv, profile)
    saveState()
    renderList()
    if (activeId === conv.convId) renderChat()
  } catch {
    // A relay restart or offline peer must not break the conversation.
  }
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
    case 'profile': {
      const conv = state.conversations.find(item => item.convId === frame.convId && item.relay === link.relay)
      if (!conv) break
      if (frame.name) conv.title = String(frame.name).slice(0, 32)
      conv.iconVersion = frame.iconVersion || Date.now()
      refreshProfile(conv)
      renderList()
      if (conv.convId === activeId) renderChat()
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
    // A confirmation can only succeed while the desktop socket is live, and
    // the relay may have emitted its presence frame before this client had a
    // conversation object to match it against. Start online and let later
    // presence frames correct it.
    online: true,
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
  refreshProfile(conv)
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
    paintAvatar(avatar, conv)
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
    snippet.textContent = last ? snippetOf(last) : '已连接，可以发消息'
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

function fmtSize(bytes) {
  const n = Number(bytes || 0)
  if (!n) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function base64ForNative(bytes) {
  return b64u(bytes).replace(/-/g, '+').replace(/_/g, '/')
}

async function decryptAttachment(conv, message) {
  const meta = message.meta || {}
  if (!meta.blobId || !meta.blobNonce || !meta.blobAad) throw new Error('附件信息不完整')
  const ciphertext = await downloadBlob(state.identity, conv.relay, conv.convId, meta.blobId)
  const plain = await aesDecryptBytes(fromB64u(conv.key), meta.blobNonce, b64u(ciphertext), meta.blobAad)
  if (meta.sha256 && await sha256hex(plain) !== meta.sha256) throw new Error('附件校验失败')
  return plain
}

async function openAttachment(conv, message, button, audio) {
  if (message._loading) return
  message._loading = true
  const oldText = button.textContent
  button.textContent = '解密中…'
  button.disabled = true
  try {
    if (message._objectUrl) {
      if (message.meta?.type === 'voice' && audio) {
        audio.src = message._objectUrl
        audio.hidden = false
        button.hidden = true
        audio.play().catch(() => toast('点击播放器开始播放'))
      } else if (message.meta?.type === 'image' || message.kind === 'image') {
        openImageViewer(message._objectUrl, message.meta?.name || '图片')
      } else {
        triggerDownload(message._objectUrl, message.meta?.name || 'attachment')
      }
      return
    }
    const plain = await decryptAttachment(conv, message)
    const blob = new Blob([plain], { type: message.meta?.mime || 'application/octet-stream' })
    message._objectUrl = URL.createObjectURL(blob)
    if (message.meta?.type === 'voice' && audio) {
      audio.src = message._objectUrl
      audio.hidden = false
      button.hidden = true
      audio.play().catch(() => toast('点击播放器开始播放'))
    } else if (message.meta?.type === 'image' || message.kind === 'image') {
      openImageViewer(message._objectUrl, message.meta?.name || '图片')
      button.textContent = '查看'
    } else if (window.EoNative?.saveFile) {
      const name = message.meta?.name || 'attachment'
      window.EoNative.saveFile(name, message.meta?.mime || 'application/octet-stream', base64ForNative(plain))
      toast('已保存到手机 Download/EO助手')
      button.textContent = '已保存'
    } else {
      triggerDownload(message._objectUrl, message.meta?.name || 'attachment')
    }
  } catch (error) {
    toast(`附件打开失败：${error.message || error}`)
  } finally {
    message._loading = false
    button.disabled = false
    if (!button.hidden && button.textContent === oldText) button.textContent = oldText
  }
}

function triggerDownload(url, name) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

function renderAttachmentCard(conv, message) {
  const meta = message.meta || {}
  const card = document.createElement('div')
  card.className = 'attachcard'
  const type = meta.type || message.kind
  const icon = document.createElement('div')
  icon.className = `attachicon${type === 'voice' ? ' voice' : ''}${type === 'image' ? ' image' : ''}`
  icon.textContent = type === 'voice' ? '声' : type === 'ppt' ? 'P' : type === 'image' ? '图' : '文'
  if (type === 'image' && message._objectUrl) {
    icon.textContent = ''
    icon.style.backgroundImage = `url("${message._objectUrl}")`
    icon.style.backgroundSize = 'cover'
    icon.style.backgroundPosition = 'center'
  }
  const info = document.createElement('div')
  info.className = 'attachinfo'
  const name = document.createElement('div')
  name.className = 'attachname'
  name.textContent = meta.name || `${kindLabel(message)}附件`
  const detail = document.createElement('div')
  detail.className = 'attachdetail'
  const duration = Number(meta.duration || 0)
  detail.textContent = [
    duration > 0 ? `${Math.round(duration)}"` : '',
    fmtSize(meta.size),
  ].filter(Boolean).join(' · ')
  info.append(name, detail)

  const button = document.createElement('button')
  button.className = 'attachopen'
  button.type = 'button'
  button.textContent = type === 'voice' ? '播放' : type === 'image' ? '查看' : '打开'
  const audio = document.createElement('audio')
  audio.controls = true
  audio.preload = 'none'
  audio.hidden = true
  audio.className = 'voiceaudio'
  button.addEventListener('click', () => openAttachment(conv, message, button, audio))

  card.append(icon, info, button)
  const wrap = document.createElement('div')
  wrap.append(card, audio)
  return wrap
}

function renderChat() {
  const conv = activeConv()
  if (!conv) return
  paintAvatar($('chatAvatar'), conv)
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
    body.className = 'bubblebody'
    const attachment = message.meta?.blobId || message.kind !== 'text'
    if (!attachment) {
      body.textContent = message.text
    } else {
      if (message.text) {
        const caption = document.createElement('div')
        caption.className = 'caption'
        caption.textContent = message.text
        body.append(caption)
      }
      body.append(renderAttachmentCard(conv, message))
    }
    const meta = document.createElement('span')
    meta.className = 'meta'
    const statusText = message.sender === state.identity.deviceId
      ? (message.status === 'uploading' ? '加密上传中'
        : message.status === 'sending' ? '发送中'
          : message.status === 'failed' ? '失败' : '已发送')
      : ''
    meta.textContent = [fmtTime(message.ts), statusText].filter(Boolean).join(' · ')
    bubble.append(body, meta)
    messagesEl.append(bubble)
  }
  messagesEl.scrollTop = messagesEl.scrollHeight
}function openChat(convId) {
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
  $('relayValue').textContent = state.relay ? state.relay.replace(/^https?:\/\//, '') : '扫码后自动设置'
  const connected = [...links.values()].some(link => link.connected)
  $('linkState').textContent = connected ? '已连接' : (state.relay ? '连接中 / 未连接' : '未连接')
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

async function sendAttachment(blob, kind = 'file', duration = 0) {
  const conv = activeConv()
  if (!conv) return
  if (blob.size <= 0) { toast('文件为空'); return }
  if (blob.size > MAX_FILE_BYTES) { toast('单个附件不能超过 16MB'); return }
  const isVoice = kind === 'voice'
  const name = blob.name || (isVoice ? `语音-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.webm` : 'attachment')
  const mime = blob.type || (kind === 'ppt' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/octet-stream')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const sha = await sha256hex(bytes)
  const ts = Date.now()
  const seq = Math.max(Number(conv.seq || 0), 0) + 1
  conv.seq = seq
  const blobId = newBlobId()
  const blobAad = `eo|blob|v1|${conv.convId}|${blobId}|${state.identity.deviceId}|${ts}|${sha}`
  const meta = {
    type: kind,
    name,
    mime,
    size: bytes.length,
    sha256: sha,
    blobId,
    blobAad,
    duration: duration || 0,
  }
  let encrypted
  try {
    encrypted = await aesEncryptBytes(fromB64u(conv.key), bytes, blobAad)
  } catch (error) {
    toast(`附件加密失败：${error.message || error}`)
    return
  }
  meta.blobNonce = encrypted.nonce
  const message = {
    msgId: newMessageId(),
    seq,
    sender: state.identity.deviceId,
    kind,
    ts,
    text: '',
    meta,
    status: 'uploading',
  }
  // Show the image immediately from the local bytes; the same bytes are then
  // encrypted and uploaded, so the preview never depends on a relay round trip.
  if (kind === 'image') message._objectUrl = URL.createObjectURL(blob)
  if (!Array.isArray(conv.messages)) conv.messages = []
  conv.messages.push(message)
  conv.lastMessageAt = ts
  saveState()
  renderChat()
  renderList()

  try {
    await uploadBlob(state.identity, conv.relay, conv.convId, blobId, fromB64u(encrypted.ct))
  } catch (error) {
    message.status = 'failed'
    saveState()
    renderChat()
    toast(`附件上传失败：${error.message || error}`)
    return
  }

  const envelope = {
    v: 1,
    convId: conv.convId,
    msgId: message.msgId,
    seq,
    kind,
    sender: state.identity.deviceId,
    ts,
    nonce: '',
    ct: '',
    meta: null,
  }
  try {
    const payload = await aesEncrypt(fromB64u(conv.key), JSON.stringify({ text: '', meta }), envelopeAad(envelope))
    envelope.nonce = payload.nonce
    envelope.ct = payload.ct
    envelope.sig = b64u(sign(canonicalEnvelope(envelope), state.identity.edPriv))
  } catch (error) {
    message.status = 'failed'
    saveState()
    renderChat()
    toast(`附件消息加密失败：${error.message || error}`)
    return
  }
  message.status = 'sending'
  sendFrame(conv.relay, { type: 'msg', envelope })
  saveState()
  renderChat()
  renderList()
}

async function loadBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    const url = URL.createObjectURL(file)
    try {
      const image = new Image()
      image.decoding = 'async'
      image.src = url
      await image.decode()
      return image
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
  }
}

/**
 * Phone cameras produce 8-20MB originals and sometimes HEIC. Resize to a
 * model-friendly JPEG before encryption so the relay/blob path and DSH image
 * admission stay small; PNG/GIF keep their format when already small.
 */
async function prepareImage(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('不是图片文件')
  const source = await loadBitmap(file)
  const width = source.width || source.naturalWidth
  const height = source.height || source.naturalHeight
  if (!width || !height) throw new Error('无法读取图片尺寸，请换一张 JPEG/PNG')
  const maxSide = 1600
  const scale = Math.min(1, maxSide / Math.max(width, height))
  if (scale === 1 && file.size <= 4 * 1024 * 1024 && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
    source.close?.()
    return file
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  source.close?.()
  const base = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image'
  let quality = 0.86
  let blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  while (blob && blob.size > 4 * 1024 * 1024 && quality > 0.55) {
    quality -= 0.1
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  }
  if (!blob || blob.size <= 0) throw new Error('图片压缩失败')
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
}

async function sendSelectedImage(file) {
  if (!file) return
  toast('正在压缩图片…')
  try {
    const prepared = await prepareImage(file)
    await sendAttachment(prepared, 'image')
  } catch (error) {
    toast(`图片处理失败：${error.message || error}`)
  }
}

function sendSelectedFile(file) {
  if (!file) return
  if (String(file.type || '').startsWith('image/')) {
    sendSelectedImage(file)
    return
  }
  const kind = /\.(pptx?)$/i.test(file.name || '') ? 'ppt' : 'file'
  sendAttachment(file, kind)
}

function pickAudioMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
  if (typeof MediaRecorder === 'undefined') return ''
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

async function toggleRecording() {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop()
    return
  }
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    toast('当前环境不支持录音')
    return
  }
  try {
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (error) {
    toast(`无法打开麦克风：${error.message || error}`)
    return
  }
  const mime = pickAudioMime()
  recorder = new MediaRecorder(recordStream, mime ? { mimeType: mime } : undefined)
  recordChunks = []
  recordStartedAt = Date.now()
  recorder.ondataavailable = (event) => {
    if (event.data?.size) recordChunks.push(event.data)
  }
  recorder.onstop = async () => {
    const durationMs = Math.min(Date.now() - recordStartedAt, MAX_VOICE_MS + 2000)
    const blob = new Blob(recordChunks, { type: recorder.mimeType || mime || 'audio/webm' })
    recordChunks = []
    if (recordStream) {
      for (const track of recordStream.getTracks()) track.stop()
      recordStream = null
    }
    resetRecordButton()
    if (blob.size > 512) sendAttachment(blob, 'voice', durationMs / 1000)
  }
  recorder.onerror = (event) => {
    toast(`录音失败：${event.error?.message || event.error || '未知错误'}`)
    resetRecordButton()
  }
  recorder.start()
  const voiceBtn = $('voiceBtn')
  voiceBtn.textContent = '停止'
  voiceBtn.classList.add('recording')
  recordTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - recordStartedAt) / 1000)
    voiceBtn.textContent = `停止 ${Math.min(seconds, 120)}s`
    if (seconds >= MAX_VOICE_MS / 1000) recorder?.stop()
  }, 500)
}

function resetRecordButton() {
  if (recordTimer) clearInterval(recordTimer)
  recordTimer = null
  recorder = null
  const voiceBtn = $('voiceBtn')
  if (voiceBtn) {
    voiceBtn.textContent = '语音'
    voiceBtn.classList.remove('recording')
  }
}



function openSettings() {
  renderSettings()
  $('settingsModal').hidden = false
}

function openImageViewer(url, name) {
  $('imageViewerImg').src = url
  $('imageViewerName').textContent = name || '图片'
  $('imageViewer').hidden = false
}

function closeImageViewer() {
  $('imageViewer').hidden = true
  $('imageViewerImg').removeAttribute('src')
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

async function consumeBindHash() {
  if (!location.hash.startsWith('#bind=')) return false
  const encoded = location.hash.slice('#bind='.length)
  let text = ''
  try {
    text = new TextDecoder().decode(fromB64u(encoded))
  } catch {
    text = decodeURIComponent(encoded)
  }
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}`)
  } catch { /* WebView may ignore history for a local origin */ }
  await handleBindText(text)
  return true
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
  // When the PWA is served by a relay, that origin is the relay. The bundled
  // Android setup page uses app.local and must wait for the QR instead.
  if (!state.relay && /^https?:$/.test(location.protocol) && location.hostname !== 'app.local') {
    state.relay = location.origin
  }
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
  for (const conv of state.conversations) refreshProfile(conv)
  await consumeBindHash()
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
$('attachBtn').addEventListener('click', () => $('fileInput').click())
$('fileInput').addEventListener('change', (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  sendSelectedFile(file)
})
$('imageBtn').addEventListener('click', () => $('imageInput').click())
$('imageInput').addEventListener('change', (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  sendSelectedImage(file)
})
$('imageViewerClose').addEventListener('click', closeImageViewer)
$('imageViewer').addEventListener('click', (event) => {
  if (event.target === $('imageViewer')) closeImageViewer()
})
$('voiceBtn').addEventListener('click', toggleRecording)
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
