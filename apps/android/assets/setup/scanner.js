(async function () {
  const statusEl = document.getElementById('status')
  const video = document.getElementById('video')
  let stream = null
  let stopped = false
  let lastScan = 0

  function status(text, bad) {
    statusEl.textContent = text
    statusEl.classList.toggle('bad', Boolean(bad))
  }

  function parsePayload(text) {
    const value = String(text || '').trim()
    if (!value) throw new Error('二维码为空')
    try {
      const json = JSON.parse(value)
      if (json && json.kind === 'eo-bind' && typeof json.relay === 'string') {
        return { raw: value, relay: json.relay }
      }
    } catch { /* try the compact eo:// form below */ }
    if (value.startsWith('eo://bind')) {
      const url = new URL(value)
      const relay = url.searchParams.get('r') || ''
      if (!relay) throw new Error('二维码缺少 relay')
      return { raw: value, relay }
    }
    throw new Error('不是 EO助手 的连接二维码')
  }

  function onCode(text) {
    if (stopped) return
    let parsed
    try { parsed = parsePayload(text) } catch (error) { status(error.message, true); return }
    stopped = true
    status('已识别，正在连接…')
    try {
      if (window.EoSetup && typeof window.EoSetup.connect === 'function') {
        window.EoSetup.connect(parsed.raw, parsed.relay)
      } else {
        status('原生连接桥不可用', true)
      }
    } catch (error) {
      status(error.message || String(error), true)
    }
  }

  function scan() {
    if (stopped) return
    if (video.readyState >= 2 && video.videoWidth > 0) {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const image = context.getImageData(0, 0, canvas.width, canvas.height)
      const code = window.jsQR ? window.jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' }) : null
      if (code && code.data && Date.now() - lastScan > 600) {
        lastScan = Date.now()
        onCode(code.data)
      }
    }
    requestAnimationFrame(scan)
  }

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('当前 WebView 不支持相机')
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
    video.srcObject = stream
    await video.play()
    status('将二维码放入框内，自动识别')
    requestAnimationFrame(scan)
  } catch (error) {
    status('无法打开相机：' + (error.message || error), true)
  }

  window.addEventListener('pagehide', function () {
    stopped = true
    if (stream) for (const track of stream.getTracks()) track.stop()
  })
})()
