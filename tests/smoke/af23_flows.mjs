import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findBrowser, ROOT } from './browser-path.mjs'


async function clickVisible(page, selector) {
  await page.bringToFront()
  for(let i=0;i<4;i++) {
    const el=await page.$(selector);assert.ok(el,selector)
    await el.evaluate(e=>e.scrollIntoView({block:'center'}))
    const box=await el.boundingBox();assert.ok(box,selector)
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
    if(!await page.evaluate(({selector,box})=>{const e=document.querySelector(selector),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return e&&(hit===e||e.contains(hit))},{selector,box}))continue
    await page.mouse.click(box.x+box.width/2,box.y+box.height/2);return
  }
  throw new Error('Control moved or covered: '+selector)
}

const fixture = `<!doctype html><meta charset="utf-8"><style>body{font:18px sans-serif}td{padding:25px;border:1px solid}table{margin:40px}strong{display:block;margin:40px}</style><table><tr><td>product</td><td><table id="prices"><tr><td>price</td><td id="value">123</td></tr><tr><td>other</td><td>456</td></tr></table></td></tr></table><strong id="scalar">1.234</strong><strong id="replacement">777</strong><input type="password" value="AF23_PASSWORD_SENTINEL"><input type="hidden" value="AF23_HIDDEN_SENTINEL"><div style="height:1100px">below</div>`
const server = http.createServer((req,res) => {res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(fixture)})
const profile = mkdtempSync(join(tmpdir(),'af23-flows-'))
const cases=new Set((process.env.AF23_CASES||'edit,report,cache,a11y,keyboard,recovery').split(','))
for(const name of cases)if(!['edit','report','cache','a11y','keyboard','recovery'].includes(name))throw new Error(`Unknown AF23_CASES: ${name}`)
let browser
const requests=[]
try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const url = `http://127.0.0.1:${server.address().port}/`
  browser = await puppeteer.launch({executablePath:findBrowser(), headless:process.env.AF23_HEADLESS==='1',userDataDir:profile,args:[`--disable-extensions-except=${resolve(ROOT,'src')}`,`--load-extension=${resolve(ROOT,'src')}`,'--no-first-run','--no-default-browser-check']})
  browser.on('targetcreated',async target=>{
    try{const page=await target.page();page?.on('request',request=>requests.push({url:request.url(),body:request.postData()||''}))}catch{}
  })
  const worker = await browser.waitForTarget(t=>t.type()==='service_worker' && t.url().endsWith('/background/main.js'))
  const extId = new URL(worker.url()).host
  const panel = await browser.newPage()
  await panel.goto(`chrome-extension://${extId}/ui/report/report.html#view=settings`)
  await panel.evaluate(async url => {
    const s=await import(chrome.runtime.getURL('shared/storage.js'))
    await s.saveTask({id:'af23-cell',name:'Fixture repair',url,mode:'multi',enabled:true,
      fields:[{key:'value',name:'price',mode:'number'},{key:'scalar',name:'scalar',mode:'number'}],
      spec:{mode:'multi',fields:[
        {key:'value',mode:'number',source:{locator:{css:'#prices'}},spec:{cell:{row:{index:0},col:{index:1}}}},
        {key:'scalar',mode:'number',source:{locator:{css:'#scalar'}},spec:{mode:'number',strategy:'auto',multiplier:100,decimals:2}}
      ]},schedule:{type:'daily',times:['09:30'],weekdays:[0,1,2,3,4,5,6]}})
  },url)
  await panel.goto(`chrome-extension://${extId}/ui/picker/picker.html?taskId=af23-cell`)
  await panel.waitForSelector('[data-field-key="value"] [data-field-repair]',{visible:true})
  if(cases.has('edit')) for(let round=0;round<2;round++) {
  const requestStart=requests.length
  const snapshot = () => panel.evaluate(async()=>{
    const local=await chrome.storage.local.get(null);delete local.diag
    return {local,alarms:await chrome.alarms.getAll()}
  })
  const beforePreview=await snapshot()
  await panel.click('#name',{clickCount:3})
  await panel.type('#name','未儲存名稱')
  await panel.waitForSelector('#test-now',{visible:true})
  await panel.click('#test-now')
  await panel.waitForFunction(()=>!document.querySelector('#test-now').disabled && document.querySelector('#preview')?.textContent.includes('123'),{timeout:20000})
  const preview=await panel.$eval('#preview',e=>e.textContent)
  console.log('[AC-C1/C2] preview',preview)
  assert.match(preview,/123\.4/)
  assert.deepEqual(await snapshot(),beforePreview,'interactive preview cannot mutate formal state')
  const previewRequests=requests.slice(requestStart)
  assert.ok(previewRequests.every(request=>request.url.startsWith(url)||request.url.startsWith('chrome-extension://'+extId+'/')),'preview uses only selected fixture/extension URLs')
  const diagnostics=await panel.evaluate(async()=>JSON.stringify((await chrome.storage.local.get('diag')).diag||[]))
  assert.doesNotMatch(JSON.stringify(previewRequests)+diagnostics,/AF23_PASSWORD_SENTINEL|AF23_HIDDEN_SENTINEL/,'unselected secrets do not appear in network or diagnostics')
  assert.equal(await panel.$eval('#name',e=>e.value),'未儲存名稱')
  const oldTargets=new Set(browser.targets())
  await panel.click('[data-field-key="value"] [data-field-repair]')
  const target=await browser.waitForTarget(t=>!oldTargets.has(t)&&t.url()===url)
  const page=await target.page()
  await page.waitForSelector('[data-af-done]',{visible:true})
  await clickVisible(page,'#value')
  assert.ok(await page.$('[data-af-picked]'),'a real source is selected')
  await clickVisible(page,'[data-af-done]')
  if(!page.isClosed()) await Promise.race([new Promise(resolve=>page.once('close',resolve)),new Promise((_,reject)=>setTimeout(()=>reject(new Error('repair close timeout')),5000))])
  assert.ok(page.isClosed(),'repair must receive persisted acknowledgement and close its own tab')
  await panel.bringToFront()
  try { await panel.waitForFunction(()=>document.querySelector('[data-field-key="value"]')?.textContent.includes('立即儲存'),{polling:100,timeout:10000}) } catch(error) {
    console.log('[repair diagnostic]',await panel.evaluate(async()=>({rows:document.querySelector('#field-list')?.innerText,notice:document.querySelector('#panel-notice')?.textContent,task:(await chrome.storage.local.get('tasks')).tasks,journal:(await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations})))
    throw error
  }
  assert.equal(await panel.$eval('#name',e=>e.value),'未儲存名稱')
  assert.equal((await snapshot()).local.tasks[0].name,'Fixture repair')
  console.log('[PASS] AC-A1/C1/C2/C4 repair browser seam')
  }
  if(cases.has('report')) for(let round=0;round<2;round++) {
  const layoutFixture=await panel.evaluate(async()=>{
    const l=await import(chrome.runtime.getURL('shared/layout-store.js'))
    const layout=await l.getLayout()
    const dash=layout.dashboards[0].id
    const card=await l.addCard(dash,{type:'table',title:'Fixture card',source:[{taskId:'af23-cell#value'},{taskId:'af23-cell#scalar'}],options:{mode:'list',limit:10}})
    return {dash,card:card.id}
  })
  const reports=[]
  for(let i=0;i<2;i++){
    const report=await browser.newPage();reports.push(report)
    await report.goto(`chrome-extension://${extId}/ui/report/report.html#view=dashboard&dash=${layoutFixture.dash}`)
    await report.waitForSelector(`[data-card-id="${layoutFixture.card}"] [data-action="config"]`,{visible:true})
    await report.click(`[data-card-id="${layoutFixture.card}"] [data-action="config"]`)
    await report.waitForSelector('#drawer-title',{visible:true})
  }
  await reports[0].bringToFront()
  await reports[0].click('#drawer-title',{clickCount:3});await reports[0].type('#drawer-title','另一頁保留標題')
  await reports[1].bringToFront()
  await reports[1].locator('#drawer-limit').fill('42')
  await reports[1].click('#drawer-apply')
  await reports[1].waitForSelector('#card-drawer',{hidden:true})
  await reports[0].bringToFront()
  await reports[0].click('#drawer-apply')
  await reports[0].waitForSelector('#card-drawer',{hidden:true})
  const card=await reports[0].evaluate(async({dash,card})=>(await(await import(chrome.runtime.getURL('shared/layout-store.js'))).getLayout()).dashboards.find(d=>d.id===dash).cards.find(c=>c.id===card),layoutFixture)
  assert.equal(card.title,'另一頁保留標題');assert.equal(card.options.limit,42)
  console.log('[PASS] AC-B4 two report pages preserve independent card changes')
  for(const report of reports)await report.close()
  }
  if(cases.has('cache')) {
  const history=await browser.newPage()
  await history.evaluateOnNewDocument(()=>{
    const get=chrome.storage.local.get.bind(chrome.storage.local)
    window.af23Reads={all:0,records:0}
    chrome.storage.local.get=function(keys,...rest){
      if(keys===null||keys===undefined)window.af23Reads.all++
      const list=typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(keys||{})
      if(list.some(k=>/^rec2?:/.test(k)))window.af23Reads.records++
      return get(keys,...rest)
    }
  })
  await history.goto(`chrome-extension://${extId}/ui/report/report.html#view=settings&from=2026-10-20&to=2026-10-20`)
  await history.waitForSelector('#storage-stats button',{visible:true})
  assert.deepEqual(await history.evaluate(()=>window.af23Reads),{all:0,records:0})
  assert.deepEqual(await history.evaluate(()=>({
    historyRows:document.querySelectorAll('#record-table tbody tr').length,
    calendarTables:document.querySelectorAll('#calendar table').length
  })),{historyRows:0,calendarTables:0},'settings does not render hidden history or calendar')
  await panel.evaluate(async()=>{
    const s=await import(chrome.runtime.getURL('shared/storage.js'))
    await s.appendRecord('2026-10-20',{taskId:'af23-cell#scalar',slot:'2026-10-20T09:30',capturedAt:'2026-10-20T01:30:00Z',value:123.4,raw:'123.4',status:'ok'})
  })
  await history.bringToFront();await history.click('#tab-history')
  await history.waitForFunction(()=>document.querySelector('#record-table')?.textContent.includes('123.4'))
  await history.click('#tab-settings')
  await panel.evaluate(async()=>{
    const s=await import(chrome.runtime.getURL('shared/storage.js'))
    await s.appendRecord('2026-10-20',{taskId:'af23-cell#scalar',slot:'2026-10-20T10:30',capturedAt:'2026-10-20T02:30:00Z',value:777.7,raw:'777.7',status:'ok'})
  })
  await history.click('#tab-history')
  await history.waitForFunction(()=>document.querySelector('#record-table')?.textContent.includes('777.7'))
  console.log('[PASS] AC-D1/D3 settings reads zero records; hidden-page write invalidates history cache')
  await history.close()
  }
  if(cases.has('a11y')) {
    const directory=process.env.AF23_EVIDENCE_DIR||join(profile,'screenshots')
    mkdirSync(directory,{recursive:true})
    for(const [width,zoom] of [[360,1],[360,2],[1280,1],[1280,2]]) {
      await panel.bringToFront()
      await panel.setViewport({width,height:900})
      await panel.evaluate(async zoom=>{const tab=await chrome.tabs.getCurrent();await chrome.tabs.setZoom(tab.id,zoom)},zoom)
      await panel.locator('#name').fill('')
      await panel.keyboard.press('Tab')
      assert.equal(await panel.$eval('#name',e=>e.getAttribute('aria-invalid')),'true')
      await panel.waitForSelector('#name-error',{visible:true})
      const nameError=await panel.$eval('#name-error',e=>({hidden:e.hidden,text:e.textContent.trim(),live:e.getAttribute('aria-live')}))
      assert.equal(nameError.hidden,false,'name error is visible')
      assert.match(nameError.text,/名稱/,'name error has visible explanatory text')
      assert.equal(nameError.live,'polite','name error is a polite live region')
      assert.ok(await panel.$eval('#name',e=>(e.getAttribute('aria-describedby')||'').split(/\s+/).includes('name-error')),
        'the invalid name field is explicitly associated with its error text')
      await panel.locator('#name').fill('Fixture repair')
      await panel.keyboard.press('Tab')
      for(const selector of ['#field-list [data-field-name]', '#field-list [data-field-repair]', '#field-list [data-field-replace]', '#test-now','#save','#cancel']) {
        await panel.$eval(selector,e=>e.scrollIntoView({block:'center'}))
        const visible=await panel.$eval(selector,e=>{
          const b=e.getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth-1,b.x+b.width/2)),y=Math.max(0,Math.min(innerHeight-1,b.y+b.height/2))
          const hit=document.elementFromPoint(x,y)
          return b.width>0&&b.height>0&&b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&(hit===e||e.contains(hit))
        })
        assert.ok(visible,`${selector} reachable at ${width}px / ${zoom*100}%`)
      }
      assert.ok(await panel.$eval('#field-list',e=>e.scrollWidth<=e.clientWidth+1),
        `field controls require no horizontal scrolling at ${width}px / ${zoom*100}%`)
      assert.ok(await panel.$eval('#field-list [data-field-name]',e=>e.getBoundingClientRect().width>=70),
        `field name stays editable at ${width}px / ${zoom*100}%`)
      await panel.$eval('#field-list [data-field-name]',e=>e.scrollIntoView({block:'center'}))
      await panel.screenshot({path:join(directory,`picker-${width}-zoom${zoom}.png`),captureBeyondViewport:false})
      console.log(`[PASS] AC-F3 ${width}px / ${zoom*100}% visible actions and field errors`)
    }
    await panel.evaluate(async()=>{const tab=await chrome.tabs.getCurrent();await chrome.tabs.setZoom(tab.id,1)})
  }


  if(cases.has('keyboard')) {
    await panel.bringToFront();await panel.setViewport({width:360,height:900})
    for(let round=0;round<2;round++) {
      await panel.focus('#name')
      await panel.keyboard.press('Tab');const next=await panel.evaluate(()=>document.activeElement?.outerHTML)
      await panel.keyboard.down('Shift');await panel.keyboard.press('Tab');await panel.keyboard.up('Shift')
      assert.equal(await panel.evaluate(()=>document.activeElement?.id),'name','Shift+Tab returns to prior field')
      await panel.keyboard.press('Tab');assert.equal(await panel.evaluate(()=>document.activeElement?.outerHTML),next)
      let found=false
      for(let i=0;i<100;i++) {
        if(await panel.evaluate(()=>document.activeElement?.id==='test-now')){found=true;break}
        await panel.keyboard.press('Tab')
      }
      assert.ok(found,'test button reachable by keyboard without focus trap')
      const focus=await panel.$eval('#test-now',e=>({visible:e.matches(':focus-visible'),width:getComputedStyle(e).outlineWidth,style:getComputedStyle(e).outlineStyle,shadow:getComputedStyle(e).boxShadow}))
      assert.ok(focus.visible&&(focus.style!=='none'&&focus.width!=='0px'||focus.shadow!=='none'),'keyboard focus is visible')
      await panel.keyboard.press('Enter')
      await panel.waitForFunction(()=>!document.querySelector('#test-now').disabled&&document.querySelector('#preview')?.textContent.includes('123.4'),{timeout:20000})
      const before=new Set(browser.targets())
      await panel.click('[data-field-key="value"] [data-field-repair]')
      const target=await browser.waitForTarget(t=>!before.has(t)&&t.url()===url)
      const page=await target.page();await page.waitForSelector('[data-af-done]',{visible:true});await page.bringToFront()
      await page.keyboard.press('Escape')
      await panel.bringToFront()
      await panel.waitForFunction(()=>!document.querySelector('[data-field-key="value"] [data-field-repair]').disabled)
      if(!page.isClosed())await page.close()
    }
    console.log('[PASS] AC-F1/F3 two keyboard rounds: Tab/Shift+Tab/Enter/Escape, visible focus and cancel unlock')
  }
  if(cases.has('recovery')) {
    await panel.bringToFront()
    const oldTargets=new Set(browser.targets())
    panel.once('dialog',dialog=>dialog.accept())
    await panel.click('[data-field-key="value"] [data-field-replace]')
    const target=await browser.waitForTarget(t=>!oldTargets.has(t)&&t.url()===url)
    const page=await target.page();await page.waitForSelector('[data-af-done]',{visible:true})
    const background=await worker.worker()
    await background.evaluate(()=>{
      const set=chrome.storage.local.set.bind(chrome.storage.local)
      chrome.storage.local.set=async values=>{
        if(Object.hasOwn(values,'tasks')) {
          const journal=(await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations
          if(journal&&Object.values(journal).some(op=>op?.status==='prepared'))throw new Error('AF23 injected interruption before task persistence')
        }
        return set(values)
      }
    })
    await clickVisible(page,'#replacement');await clickVisible(page,'[data-af-done]')
    await page.waitForFunction(()=>document.querySelector('[data-af-done]')?.textContent.includes('再次確認'),{timeout:20000})
    const pending=await panel.evaluate(async()=>({journal:(await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations,task:await(await import(chrome.runtime.getURL('shared/storage.js'))).getTask('af23-cell')}))
    assert.ok(pending.task.fields.some(f=>f.key==='value'),'interrupted task not committed yet')
    assert.equal(Object.values(pending.journal).filter(op=>op.status!=='complete').length,1)
    console.log('[recovery] prepared journal verified; restarting isolated browser')
    await browser.close()
    browser=await puppeteer.launch({executablePath:findBrowser(),headless:process.env.AF23_HEADLESS==='1',userDataDir:profile,args:[`--disable-extensions-except=${resolve(ROOT,'src')}`,`--load-extension=${resolve(ROOT,'src')}`,'--no-first-run','--no-default-browser-check']})
    const nextWorker=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background/main.js'),{timeout:20000})
    let resumed=await browser.newPage()
    await resumed.goto('chrome-extension://'+extId+'/ui/picker/picker.html?taskId=af23-cell')
    console.log('[recovery] worker restarted; checking journal')
    await resumed.waitForFunction(async()=>Object.values((await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations||{}).every(op=>op.status==='complete'))
    const state=()=>resumed.evaluate(async()=>({journal:(await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations,task:await(await import(chrome.runtime.getURL('shared/storage.js'))).getTask('af23-cell')}))
    const after=await state()
    assert.equal(after.task.archivedFields.filter(f=>f.key==='value').length,1)
    assert.equal(after.task.fields.length,2);assert.ok(!after.task.fields.some(f=>f.key==='value'))
    await browser.close()
    browser=await puppeteer.launch({executablePath:findBrowser(),headless:process.env.AF23_HEADLESS==='1',userDataDir:profile,args:[`--disable-extensions-except=${resolve(ROOT,'src')}`,`--load-extension=${resolve(ROOT,'src')}`,'--no-first-run','--no-default-browser-check']})
    await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background/main.js'),{timeout:20000})
    resumed=await browser.newPage()
    await resumed.goto('chrome-extension://'+extId+'/ui/picker/picker.html?taskId=af23-cell')
    assert.deepEqual(await state(),after,'recovery twice cannot replace again')
    assert.ok(page.isClosed(),'old browser was closed; its source tab cannot survive restart')
    await resumed.close()
    console.log('[PASS] AC-A3/A4 real worker restart resumes same prepared replacement exactly once')
  }
} catch(error) {console.error(error);process.exitCode=1}
finally {if(browser)await browser.close();server.closeAllConnections?.();if(server.listening)await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:200})}
