import { chromium } from 'playwright-core'
import fs from 'node:fs'
const token = process.env.TOKEN
if (!token) throw new Error('TOKEN required')
const browser = await chromium.launch({ executablePath: '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
desktop.on('console', m => { if (m.type() === 'error') console.log('DSH_ERR', m.text()) })
mobile.on('console', m => { if (m.type() === 'error') console.log('PWA_ERR', m.text()) })

await desktop.goto(`http://127.0.0.1:8790/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await desktop.waitForTimeout(2200)
const cont = desktop.getByRole('button', { name: /Continue/i })
if (await cont.count()) await cont.first().click()
await desktop.waitForTimeout(600)
await desktop.keyboard.press('Escape')
await desktop.getByText('More', { exact: true }).last().click()
await desktop.waitForTimeout(400)
await desktop.getByText('Settings', { exact: true }).click()
await desktop.waitForTimeout(900)
await desktop.getByText('EO助手连接', { exact: true }).click()
await desktop.waitForTimeout(600)
await desktop.getByRole('button', { name: /生成二维码|刷新二维码|再绑定一台手机/ }).first().click()
await desktop.waitForTimeout(700)
const src = await desktop.locator('img[alt="EO助手绑定二维码"]').getAttribute('src')
console.log('QR_SRC', src.slice(0, 40), 'len', src.length)
await desktop.addScriptTag({ path: '/home/user/Doubao/chats/38455714111537410/eo-assistant/apps/android/assets/setup/jsQR.js' })
const payload = await desktop.evaluate(async (src) => {
  const img = new Image()
  img.src = src
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const result = window.jsQR(data.data, data.width, data.height)
  return result?.data || ''
}, src)
console.log('PAYLOAD', payload.slice(0, 120), 'len', payload.length)
if (!payload.startsWith('eo://bind')) throw new Error('QR decode failed')

const encoded = Buffer.from(payload, 'utf8').toString('base64url')
await mobile.goto(`http://127.0.0.1:8787/app/#bind=${encoded}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await mobile.waitForTimeout(2500)
console.log('MOBILE_TEXT', (await mobile.locator('body').innerText()).slice(0, 900))
console.log('CODE_INPUT', await mobile.locator('input').count())
// Wait for desktop settings to show the code.
let code = ''
for (let i = 0; i < 15; i++) {
  await desktop.waitForTimeout(1000)
  const text = await desktop.locator('body').innerText()
  const m = text.match(/(?:绑定码|确认码|code)[^\d]{0,12}(\d{6})/i)
  if (m) { code = m[1]; break }
}
console.log('CODE', code)
if (code) {
  const inputs = mobile.locator('#codeInput')
  if (await inputs.count()) {
    await inputs.first().fill(code)
    const confirm = mobile.locator('#codeBtn')
    if (await confirm.count()) await confirm.first().click()
    await mobile.waitForTimeout(2000)
  }
}
console.log('MOBILE_AFTER', (await mobile.locator('body').innerText()).slice(0, 1000))
await mobile.screenshot({ path: '/tmp/eo-mobile-after-bind.png' })
await desktop.screenshot({ path: '/tmp/eo-desktop-after-bind.png' })

// Send an image if the composer exists.
const fileInput = mobile.locator('input[type=file]').last()
if (await fileInput.count()) {
  await fileInput.setInputFiles('/tmp/eo-valid.jpg')
  await mobile.waitForTimeout(5000)
  console.log('MOBILE_WITH_IMAGE', (await mobile.locator('body').innerText()).slice(0, 1200))
  await mobile.screenshot({ path: '/tmp/eo-mobile-image.png' })
}
await browser.close()
