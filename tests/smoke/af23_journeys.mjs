// AF-23 F1: two sequential single-value and source-drift/repair/drag journeys.
// Opening the extension entry uses its public ENTER_PICK message because
// Chromium's toolbar is not page DOM; all selection/form/repair/save/drag actions
// below use visible production controls and actual mouse/keyboard events.
import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import http from 'node:http'
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {performance} from 'node:perf_hooks'
import {findBrowser,ROOT} from './browser-path.mjs'
const html=`<!doctype html><meta charset="utf-8"><title>Journey fixture</title><style>body{font:18px sans-serif;padding:30px}td,th{padding:25px;border:1px solid}strong{display:block;padding:25px}</style><strong id="scalar">42</strong><table id="prices"><tbody><tr><td>1</td><td id="value">123</td></tr><tr><td>2</td><td>456</td></tr></tbody></table>`
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html)})
const profile=mkdtempSync(join(tmpdir(),'af23-journeys-'))
let browser,clicks=0,transitions=0
const evidence=[]
async function click(page,selector){
 await page.bringToFront()
 for(let i=0;i<4;i++){
  const el=await page.$(selector);assert.ok(el,selector)
  await el.evaluate(e=>e.scrollIntoView({block:'center'}))
  const box=await el.boundingBox();assert.ok(box,selector+' visible')
  const x=box.x+box.width/2,y=box.y+box.height/2
  await page.mouse.move(x,y)
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
  if(!await page.evaluate(({selector,x,y})=>{const e=document.querySelector(selector),hit=document.elementFromPoint(x,y);return e&&!e.disabled&&!e.closest('[hidden]')&&(hit===e||e.contains(hit))},{selector,x,y}))continue
  await page.mouse.click(x,y);clicks++;return
 }
 throw new Error('covered or unstable control '+selector)
}
async function wait(page,fn,...args){return page.waitForFunction(fn,{polling:100,timeout:20000},...args)}
async function openRepair(editor,url){
 const old=new Set(browser.targets());await click(editor,'[data-field-key="price"] [data-field-repair]')
 const target=await browser.waitForTarget(t=>!old.has(t)&&t.url()===url)
 const page=await target.page();await page.waitForSelector('[data-af-done]',{visible:true});transitions++;return page
}
async function drag(page,from,to){
 await page.bringToFront();await page.$eval(from,e=>e.scrollIntoView({block:'center'}))
 const a=await(await page.$(from)).boundingBox(),b=await(await page.$(to)).boundingBox();assert.ok(a&&b,'drag endpoints visible')
 await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down()
 await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:16});await page.mouse.up();clicks++
}
try{
 await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)})
 const url=`http://127.0.0.1:${server.address().port}/`
 browser=await puppeteer.launch({executablePath:findBrowser(),headless:process.env.AF23_HEADLESS==='1',userDataDir:profile,args:[`--disable-extensions-except=${resolve(ROOT,'src')}`,`--load-extension=${resolve(ROOT,'src')}`,'--no-first-run','--no-default-browser-check']})
 const worker=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background/main.js'))
 const ext=new URL(worker.url()).host,control=await browser.newPage()
 await control.goto(`chrome-extension://${ext}/ui/report/report.html#view=settings`)
 for(let round=1;round<=2;round++){
  console.log('[journey] begin round',round)
  let started=performance.now();clicks=0;transitions=0
  const source=await browser.newPage();await source.goto(url,{waitUntil:'load'})
  const tabId=await control.evaluate(async u=>(await chrome.tabs.query({url:u})).at(-1).id,url)
  const enter=await control.evaluate(async id=>chrome.runtime.sendMessage({type:'ENTER_PICK',purpose:'task',tabId:id,frameId:0}),tabId)
  assert.equal(enter.ok,true)
  const editor=await browser.newPage();await editor.goto(`chrome-extension://${ext}/ui/picker/picker.html?tabId=${tabId}`)
  await source.waitForSelector('[data-af-done]',{visible:true})
  await click(source,'#scalar');await click(source,'[data-af-done]');transitions++
  await editor.waitForSelector('#name',{visible:true})
  await click(editor,'#name')
  await editor.locator('#name').fill(`單值旅程 ${round}`)
  assert.equal(await editor.$eval('#group-name-editor',e=>Boolean(e&&!e.hidden)),false,'single path has no required group naming')
  console.log('[journey] source selected, editor ready',round)
  await click(editor,'#test-now');await wait(editor,()=>document.querySelector('#preview')?.textContent.trim()==='42'&&!document.querySelector('#test-now').disabled)
  await click(editor,'#save')
  await wait(editor,()=>document.querySelector('#saved-feedback [data-saved-first]')?.dataset.state==='ok')
  console.log('[journey] saved first value',round)
  const saved=await control.evaluate(async name=>{
   const s=await import(chrome.runtime.getURL('shared/storage.js'));const task=(await s.getTasks()).find(t=>t.name===name)
   const records=(await Promise.all((await s.listDates()).map(d=>s.getRecordsByDate(d)))).flat().filter(r=>r.taskId===task?.id||r.taskId.startsWith(task?.id+'#'))
   return {task,records}
  },`單值旅程 ${round}`)
  assert.ok(saved.task);assert.ok(saved.records.some(r=>r.value===42),'first value persisted')
  const old=new Set(browser.targets());await click(editor,'#saved-open-report');transitions++
  const resultTarget=await browser.waitForTarget(t=>!old.has(t)&&t.url().includes('/ui/report/report.html'))
  const resultPage=await resultTarget.page();await resultPage.waitForSelector('#tab-history',{visible:true})
  await click(resultPage,'#tab-history');await wait(resultPage,()=>document.querySelector('#record-table')?.textContent.includes('42'))
  evidence.push({round,flow:'new-single-preview-save-first-result',clicks,formEdits:1,screenTransitions:transitions,elapsedMs:+(performance.now()-started).toFixed(2),value:42,status:'PASS'})
  await resultPage.close();if(!editor.isClosed())await editor.close();await source.close()

  started=performance.now();clicks=0;transitions=0
  const taskId='journey-multi-'+round
  const fixture=await control.evaluate(async({taskId,url})=>{
   const s=await import(chrome.runtime.getURL('shared/storage.js')),l=await import(chrome.runtime.getURL('shared/layout-store.js'))
   await s.saveTask({id:taskId,name:'動態來源 '+taskId,url,mode:'multi',enabled:true,fields:[{key:'price',name:'價格',mode:'number'},{key:'scalar',name:'正常值',mode:'number'}],spec:{mode:'multi',fields:[{key:'price',mode:'number',source:{locator:{css:'#removed'}},spec:{cell:{row:{index:0},col:{index:1}}}},{key:'scalar',mode:'number',source:{locator:{css:'#scalar'}},spec:{strategy:'auto'}}]},schedule:{type:'daily',times:['09:30'],weekdays:[0,1,2,3,4,5,6]}})
   const date=new Date().toLocaleDateString('sv-SE');await s.appendRecord(date,{taskId:taskId+'#price',slot:date+'T08:00',capturedAt:date+'T00:00:00Z',value:99,raw:'99',status:'ok'})
   const layout=await l.getLayout(),dash=layout.dashboards[0].id,card=await l.addCard(dash,{type:'table',title:'修復後拖曳',source:[],options:{mode:'list',limit:10}})
   return {date,dash,card:card.id}
  },{taskId,url})
  const repairEditor=await browser.newPage();await repairEditor.goto(`chrome-extension://${ext}/ui/picker/picker.html?taskId=${taskId}`)
  await repairEditor.waitForSelector('[data-field-key="price"] [data-field-repair]',{visible:true})
  await click(repairEditor,'#test-now');await wait(repairEditor,()=>!document.querySelector('#test-now').disabled&&document.querySelector('#preview')?.textContent.includes('42'))
  const partial=await repairEditor.$eval('#preview',e=>e.textContent);assert.match(partial,/找不到|失敗|未找到|missing/i)
  console.log('[journey] partial failure visible',round)
  let pick=await openRepair(repairEditor,url);await click(pick,'#value')
  await pick.evaluate(()=>{const tr=document.createElement('tr');tr.innerHTML='<td>1</td><td>111</td>';document.querySelector('#prices tbody').prepend(tr)})
  await click(pick,'[data-af-done]');await wait(pick,()=>/重新|來源.*改變/.test(document.querySelector('[data-af-panel]')?.textContent||''))
  assert.equal(pick.isClosed(),false)
  await click(pick,'[data-af-cancel]');await repairEditor.bringToFront();await wait(repairEditor,()=>!document.querySelector('[data-field-key="price"] [data-field-repair]').disabled)
  pick=await openRepair(repairEditor,url);await click(pick,'#value');await click(pick,'[data-af-done]')
  await wait(repairEditor,async id=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));return (await s.getTask(id)).spec.fields[0].source.locator.css!=='#removed'},taskId)
  await repairEditor.bringToFront();await wait(repairEditor,()=>!document.querySelector('[data-field-key="price"] [data-field-repair]').disabled)
  await click(repairEditor,'#test-now');await wait(repairEditor,()=>!document.querySelector('#test-now').disabled&&document.querySelector('[data-field-key="price"] [data-field-result]')?.textContent.trim()==='123')
  const report=await browser.newPage();await report.goto(`chrome-extension://${ext}/ui/report/report.html#view=dashboard&dash=${fixture.dash}`)
  await report.waitForSelector('#edit-layout',{visible:true});await click(report,'#edit-layout')
  await report.waitForSelector(`[data-palette-series="${taskId}#price"]`,{visible:true})
  await drag(report,`[data-palette-series="${taskId}#price"]`,`[data-card-id="${fixture.card}"]`)
  await wait(report,async({dash,card,taskId})=>{const l=await import(chrome.runtime.getURL('shared/layout-store.js'));return (await l.getLayout()).dashboards.find(d=>d.id===dash)?.cards.find(c=>c.id===card)?.source.some(s=>s.taskId===taskId+'#price')},{...fixture,taskId})
  await click(report,'#tab-tasks')
  await report.waitForSelector(`#task-list [data-task-id="${taskId}"] [data-action="run"]`,{visible:true})
  await click(report,`#task-list [data-task-id="${taskId}"] [data-action="run"]`)
  try {await wait(report,async({taskId,date})=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));return (await s.getRecordsByDate(date)).some(r=>r.taskId===taskId+'#price'&&r.value===123)},{taskId,date:fixture.date})} catch(error) {console.log('[formal run diagnostic]',await report.evaluate(async taskId=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));return {row:document.querySelector('[data-task-id="'+taskId+'"]')?.innerText,task:await s.getTask(taskId),records:(await Promise.all((await s.listDates()).map(d=>s.getRecordsByDate(d)))).flat(),diag:(await chrome.storage.local.get('diag')).diag}},taskId));throw error}
  const after=await control.evaluate(async({taskId,date})=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));return {task:await s.getTask(taskId),history:await s.getRecordsByDate(date)}},{taskId,date:fixture.date})
  assert.equal(after.task.fields[0].key,'price');assert.ok(after.history.some(r=>r.taskId===taskId+'#price'&&r.value===99),'repair and drag preserve existing series history');assert.ok(after.history.some(r=>r.taskId===taskId+'#price'&&r.value===123),'formal run continues repaired series')
  evidence.push({round,flow:'partial-drift-reject-cancel-repair-preview-drag',clicks,screenTransitions:transitions,elapsedMs:+(performance.now()-started).toFixed(2),historyPreserved:true,previewValue:123,status:'PASS'})
  await repairEditor.close();await report.close()
 }
 mkdirSync(resolve(ROOT,'work'),{recursive:true});writeFileSync(resolve(ROOT,'work/af23-journeys.json'),JSON.stringify({status:'PASS',rounds:2,evidence},null,2)+'\n');console.log(JSON.stringify(evidence,null,2))
}catch(error){console.error(error);process.exitCode=1}
finally{if(browser)await browser.close();server.closeAllConnections?.();if(server.listening)await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:200})}
