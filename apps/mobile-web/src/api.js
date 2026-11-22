/**
 * Signed REST + WebSocket transport. Mirrors the DSH plugin's wire format.
 */
import { b64u, sha256hex, sign, utf8 } from './crypto.js'

export function normalizeRelay(value) {
  const text = String(value || '').trim().replace(/\/+$/, '')
  if (!text) throw new Error('请填写 relay 地址')
  const url = new URL(text)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('relay 只支持 http/https')
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('公网 relay 必须使用 https，避免二维码和消息被窃听')
  }
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

export async function signedRequest(identity, relay, method, pathname, body) {
  const base = normalizeRelay(relay)
  const url = new URL(pathname, base)
  const raw = body === undefined ? '' : JSON.stringify(body)
  const ts = String(Date.now())
  const canonical = `${method}\n${url.pathname}\n${ts}\n${await sha256hex(raw)}`
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-eo-device': identity.deviceId,
      'x-eo-ts': ts,
      'x-eo-sig': b64u(sign(canonical, identity.edPriv)),
      'x-eo-ed': identity.edPub,
      'x-eo-x': identity.xPub,
    },
    body: raw || undefined,
  })
  const text = await res.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { error: text.slice(0, 200) } }
  if (!res.ok) throw new Error(data.error || `relay HTTP ${res.status}`)
  return data
}

export async function getBind(relay, bindId) {
  const base = normalizeRelay(relay)
  const res = await fetch(`${base}/v1/bind/${encodeURIComponent(bindId)}`, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `relay HTTP ${res.status}`)
  return data
}

export function wsUrl(identity, relay) {
  const base = normalizeRelay(relay)
  const url = new URL('/v1/ws', base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const ts = String(Date.now())
  const canonical = `ws\n${identity.deviceId}\n${ts}`
  url.searchParams.set('deviceId', identity.deviceId)
  url.searchParams.set('ts', ts)
  url.searchParams.set('ed', identity.edPub)
  url.searchParams.set('x', identity.xPub)
  url.searchParams.set('sig', b64u(sign(canonical, identity.edPriv)))
  return url.toString()
}

export function parseBindPayload(text) {
  const raw = String(text || '').trim()
  if (!raw.startsWith('eo://bind')) throw new Error('不是 EO助手 绑定二维码')
  const url = new URL(raw)
  const value = name => url.searchParams.get(name) || ''
  const payload = {
    version: value('v'),
    relay: value('r'),
    bindId: value('b'),
    desktopXPub: value('x'),
    nonce: value('n'),
    fingerprint: value('f'),
    name: value('name') || 'EO助手',
  }
  if (payload.version !== '1') throw new Error('二维码版本不支持')
  if (!payload.relay || !payload.bindId || !payload.desktopXPub || !payload.nonce) throw new Error('二维码字段不完整')
  return payload
}

export { utf8 }
