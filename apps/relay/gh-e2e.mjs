import { chromium } from 'playwright-core'
import fs from 'node:fs'
const base = process.env.DSH_URL || 'http://127.0.0.1:8790'
const token = process.env.TOKEN
const relay = process.env.RELAY || 'http://127.0.0.1:8787'
if (!token) throw new Error('TOKEN required')
const browser = await chromium.launch({ executablePath: '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
desktop.on('console', m => { if (m.type() === 'error') console.log('DSH_ERR', m.text()) })
mobile.on('console', m => { if (m.type() === 'error') console.log('PWA_ERR', m.text()) })
mobile.on('websocket', ws => {
  ws.on('framereceived', e => { const s=String(e.payload); if (s.includes('presence')) console.log('WS_PRESENCE', s.slice(0,180)) })
})
await desktop.goto(`${base}/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await desktop.waitForTimeout(2200)
const cont = desktop.getByRole('button', { name: /Continue/i })
if (await cont.count()) { await cont.first().click(); await desktop.waitForTimeout(700) }
await desktop.keyboard.press('Escape'); await desktop.waitForTimeout(500); await desktop.waitForTimeout(500)
await desktop.getByText('More', { exact: true }).last().click(); await desktop.waitForTimeout(400)
await desktop.getByText('Settings', { exact: true }).click(); await desktop.waitForTimeout(800)
await desktop.getByText('EO助手连接', { exact: true }).click(); await desktop.waitForTimeout(600)
const text = await desktop.locator('body').innerText()
console.log('SETTINGS_TEXT', text.slice(0,1200))
const btn = desktop.getByRole('button', { name: /生成二维码|刷新二维码|再绑定一台手机/ }).first()
if (!(await btn.count())) throw new Error('no QR button')
await btn.click(); await desktop.waitForTimeout(700)
const src = await desktop.locator('img[alt="EO助手绑定二维码"]').getAttribute('src')
console.log('QR len', src?.length)
await desktop.addScriptTag({ path: '/home/user/Doubao/chats/38455714111537410/eo-assistant/apps/android/assets/setup/jsQR.js' })
const payload = await desktop.evaluate(async src => {
  const img = new Image(); img.src = src; await img.decode()
  const c = document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight
  const x=c.getContext('2d'); x.drawImage(img,0,0); const d=x.getImageData(0,0,c.width,c.height)
  return window.jsQR(d.data,d.width,d.height)?.data || ''
}, src)
console.log('PAYLOAD', payload.slice(0,100))
await mobile.goto(`${relay}/app/#bind=${Buffer.from(payload).toString('base64url')}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await mobile.waitForTimeout(1800)
let code=''
for (let i=0;i<15;i++){ await desktop.waitForTimeout(700); const t=await desktop.locator('body').innerText(); const m=t.match(/(?:绑定码|确认码|code)[^\d]{0,12}(\d{6})/i); if(m){code=m[1];break} }
console.log('CODE',code)
await mobile.locator('#codeInput').fill(code); await mobile.locator('#codeBtn').click(); await mobile.waitForTimeout(3000)
console.log('MOBILE_AFTER',(await mobile.locator('body').innerText()).slice(0,900))
await mobile.screenshot({path:'/tmp/gh-mobile.png'})
await desktop.screenshot({path:'/tmp/gh-desktop.png'})
if (await mobile.locator('#textInput').count()) {
  await mobile.locator('#textInput').fill('插件安装验收文本')
  await mobile.locator('#sendBtn').click()
  await mobile.waitForTimeout(1500)
  console.log('AFTER_TEXT',(await mobile.locator('body').innerText()).slice(0,900))
}
if (await mobile.locator('input[type=file]').count()) {
  await mobile.locator('input[type=file]').last().setInputFiles('/tmp/eo-valid.jpg')
  await mobile.waitForTimeout(4000)
  console.log('AFTER_IMAGE',(await mobile.locator('body').innerText()).slice(0,900))
}
await browser.close()
