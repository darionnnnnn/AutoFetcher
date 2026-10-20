// T07/T08: actual preview controls and source Done/Cancel across Chrome messaging.
// Fixtures and a competing editor write use production storage APIs; ACK delay is
// injected only at the source's runtime-message boundary, never into product code.
import assert from 'node:assert/strict'
import http from 'node:http'
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import puppeteer from 'puppeteer-core'
import {ROOT,findBrowser} from './browser-path.mjs'
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<!doctype html><meta charset="utf-8"><style>body{padding:40px}strong{display:block;padding:30px}td{padding:30px}</style><strong id="old">42</strong><strong id="new">123</strong><strong id="newer">789</strong><table id="table"><tbody><tr><td>1</td><td>123</td></tr></tbody></table>')})
const profile=mkdtempSync(join(tmpdir(),'af23-preview-seams-'))
let browser
const evidence=[]
const click=async(page,selector)=>{await page.bringToFront();await page.waitForSelector(selector,{visible:true});await page.click(selector)}
const wait=(page,fn,...args)=>page.waitForFunction(fn,{timeout:15000,polling:50},...args)
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const url=`http://127.0.0.1:${server.address().port}/`
 browser=await puppeteer.launch({executablePath:findBrowser(),headless:true,userDataDir:profile,args:[`--disable-extensions-except=${resolve(ROOT,'src')}`,`--load-extension=${resolve(ROOT,'src')}`,'--no-first-run','--no-default-browser-check']})
 const worker=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background/main.js'))
 const ext=new URL(worker.url()).host,control=await browser.newPage()
 await control.goto(`chrome-extension://${ext}/ui/report/report.html#view=settings`)
 const fields=[{key:'one',name:'值',mode:'number',source:{locator:{css:'#old'}},spec:{strategy:'auto'}}]
 const tasks=[
  {id:'legacy-block',name:'表格',url,mode:'block',locator:{css:'#table'},spec:{mode:'block',block:{cell:{row:{index:0},col:{index:1}}}},enabled:true},
  {id:'one-multi',name:'單值multi',url,mode:'multi',fields:fields.map(({key,name,mode})=>({key,name,mode})),spec:{mode:'multi',fields},enabled:true}
 ]
 await control.evaluate(async tasks=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));await s.saveTasks(tasks)},tasks)
 for(const task of tasks){
  const before=await control.evaluate(async()=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));return {tasks:await s.getTasks(),dates:await s.listDates()}})
  const editor=await browser.newPage();await editor.goto(`chrome-extension://${ext}/ui/picker/picker.html?taskId=${task.id}`)
  await click(editor,'#test-now')
  await wait(editor,()=>!document.querySelector('#test-now').disabled&&document.querySelector('#preview').textContent.trim()!=='—')
  const value=await editor.$eval('#preview',e=>e.textContent.trim())
  assert.equal(value,task.id==='legacy-block'?'123':'值: 42')
  const after=await control.evaluate(async()=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));return {tasks:await s.getTasks(),dates:await s.listDates()}})
  assert.deepEqual(after,before)
  evidence.push({case:task.id,preview:value,formalDataUnchanged:true,status:'PASS'})
  await editor.close()
 }
 const editorA=await browser.newPage(),editorB=await browser.newPage()
 await editorA.goto(`chrome-extension://${ext}/ui/picker/picker.html?taskId=one-multi`)
 await editorB.goto(`chrome-extension://${ext}/ui/picker/picker.html?taskId=one-multi`)
 const oldTargets=new Set(browser.targets())
 await click(editorA,'[data-field-key="one"] [data-field-repair]')
 const source=await(await browser.waitForTarget(t=>!oldTargets.has(t)&&t.url()===url)).page()
 await source.waitForSelector('[data-af-done]',{visible:true})
 const tabId=await control.evaluate(async url=>(await chrome.tabs.query({url})).at(-1).id,url)
 await control.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>{
  const original=chrome.runtime.sendMessage.bind(chrome.runtime)
  globalThis.__af23Gate={held:false,release:null}
  chrome.runtime.sendMessage=async function(message,...args){
   if(message?.type==='PICKED'&&message.repairSessionId&&!globalThis.__af23Gate.used){
    const gate=globalThis.__af23Gate;gate.used=true;gate.held=true
    await new Promise(resolve=>{gate.release=resolve})
   }
   return original(message,...args)
  }
 }}),tabId)
 await click(source,'#new');await click(source,'[data-af-done]')
 await wait(control,async tabId=>(await chrome.scripting.executeScript({target:{tabId},func:()=>Boolean(globalThis.__af23Gate?.held)}))[0].result,tabId)
 const pending=await source.$eval('[data-af-panel]',e=>e.textContent)
 assert.match(pending,/處理|送出|確認|套用/)
 assert.equal(await control.evaluate(async()=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));return (await s.getTask('one-multi')).spec.fields[0].source.locator.css}),'#old')
 // Another real editor document saves a newer source while A's submit is held.
 await editorB.evaluate(async()=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));await s.updateTasks(['one-multi'],task=>{task.name='另一頁的新名稱';task.spec.fields[0].source.locator={css:'#newer'};return task})})
 await control.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>globalThis.__af23Gate.release()}),tabId)
 await wait(source,()=>/已變更|重新開始|失效/.test(document.querySelector('[data-af-panel]')?.textContent||''))
 assert.equal(source.isClosed(),false,'rejected selection remains recoverable')
 const after=await control.evaluate(async()=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));return s.getTask('one-multi')})
 assert.equal(after.spec.fields[0].source.locator.css,'#newer');assert.equal(after.name,'另一頁的新名稱')
 await click(source,'[data-af-cancel]')
 evidence.push({case:'delayed-submit-and-competing-editor',pendingVisible:true,unchangedBeforeACK:true,staleRejected:true,newerSourcePreserved:true,status:'PASS'})
 mkdirSync(resolve(ROOT,'work'),{recursive:true});writeFileSync(resolve(ROOT,'work/af23-preview-repair-seams.json'),JSON.stringify({status:'PASS',evidence},null,2)+'\n')
 console.log(JSON.stringify(evidence,null,2))
}catch(error){console.error(error);process.exitCode=1}
finally{await browser?.close();server.closeAllConnections?.();if(server.listening)await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200})}
