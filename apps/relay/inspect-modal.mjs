import { chromium } from 'playwright-core'
const b=await chromium.launch({executablePath:'/home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',headless:true,args:['--no-sandbox']})
const p=await b.newPage({viewport:{width:1280,height:900}})
await p.goto(`http://127.0.0.1:8791/?token=${process.env.TOKEN}`,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2500)
console.log((await p.locator('body').innerText()).slice(0,1400))
console.log('BUTTONS', await p.getByRole('button').allInnerTexts())
console.log('DIALOGS', await p.locator('[role=dialog]').count(), await p.locator('[role=presentation]').count())
await p.screenshot({path:'/tmp/modal.png'})
await b.close()
