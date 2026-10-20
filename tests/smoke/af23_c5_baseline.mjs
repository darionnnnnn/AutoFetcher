// AF-23 C5 / F1 minimal real-UI baseline comparison.
// Run once per revision with AF23_EXTENSION_PATH and AF23_LABEL. This deliberately
// measures only one scalar task and exactly two groups, not a broader journey suite.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync,mkdirSync} from 'node:fs'
import {join,relative,resolve} from 'node:path'
import {performance} from 'node:perf_hooks'
import puppeteer from 'puppeteer-core'
const ROOT=resolve(import.meta.dirname,'../..')

const SRC=resolve(process.env.AF23_EXTENSION_PATH||join(ROOT,'src'))
const LABEL=process.env.AF23_LABEL||'unspecified'
const BROWSER_CANDIDATES=[
  process.env.BROWSER_PATH,
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  join(os.homedir(),'Downloads','chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'),
  join(os.tmpdir(),'af22-cft','chrome','mac-arm64','chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'),
  join(os.tmpdir(),'af22-cft','chrome','win64-154.0.8037.57','chrome-win64','chrome.exe')
].filter(Boolean)
const BROWSER=BROWSER_CANDIDATES.find(path=>existsSync(path))
const BASELINE='75ed288ee99bce93bb70c10f7c7ef577dc587c9d'
const html='<!doctype html><meta charset="utf-8"><title>AF-23 baseline fixture</title><style>body{font:20px sans-serif;padding:36px}button{padding:18px}strong{display:block;margin:30px;padding:28px;border:2px solid #444}</style><h1>商品資料</h1><strong id="scalar">42</strong><strong id="group-a">商品甲 101</strong><strong id="group-b">商品乙 202</strong>'
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html)})
const profile=mkdtempSync(join(os.tmpdir(),'af23-c5-baseline-'))
let browser
let clicks=0,formEdits=0,transitions=0
const trace=[]
const click=async(page,selector)=>{
  await page.bringToFront()
  for(let attempt=0;attempt<5;attempt++){
    const el=await page.$(selector);assert.ok(el,`missing ${selector}`)
    await el.evaluate(e=>e.scrollIntoView({block:'center'}))
    const b=await el.boundingBox();assert.ok(b,`not visible ${selector}`)
    const x=b.x+b.width/2,y=b.y+b.height/2
    await page.mouse.move(x,y);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
    const hit=await page.evaluate(({s,x,y})=>{const e=document.querySelector(s),h=document.elementFromPoint(x,y);return e&&!e.disabled&&!e.hidden&&!e.closest('[hidden]')&&(h===e||e.contains(h))},{s:selector,x,y})
    if(!hit)continue
    await page.mouse.click(x,y);clicks++;trace.push({type:'click',selector});return
  }
  throw new Error(`control covered or unstable: ${selector}`)
}
const clickWithoutFocus=async(page,selector)=>{
  const el=await page.$(selector);assert.ok(el,`missing ${selector}`)
  await el.evaluate(e=>e.scrollIntoView({block:'center'}));await new Promise(r=>setTimeout(r,100))
  const b=await el.boundingBox();assert.ok(b,`not visible ${selector}`)
  const hit=await page.evaluate(({s,x,y})=>{const e=document.querySelector(s),h=document.elementFromPoint(x,y);return e&&!e.hidden&&!e.disabled&&!e.closest('[hidden]')&&(h===e||e.contains(h))},{s:selector,x:b.x+b.width/2,y:b.y+b.height/2})
  assert.ok(hit,`click target covered ${selector}`)
  await page.mouse.click(b.x+b.width/2,b.y+b.height/2);clicks++;trace.push({type:'click',selector})
}
const makePanelDriver=async(target)=>{
  const cdp=await target.createCDPSession();await cdp.send('Runtime.enable')
  const evaluate=async(fn,...args)=>{
    const expression=`(${fn.toString()})(...${JSON.stringify(args)})`
    const result=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true})
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text)
    return result.result?.value
  }
  const driver={evaluate,async waitForFunction(fn,options={},...args){const end=Date.now()+(options.timeout||10000);while(Date.now()<end){if(await evaluate(fn,...args))return;await new Promise(r=>setTimeout(r,100))}throw new Error('panel condition timeout')},async waitForSelector(selector,options={}){const end=Date.now()+(options.timeout||10000);while(Date.now()<end){if(await evaluate(({s,visible})=>{const e=document.querySelector(s);return Boolean(e&&(!visible||(!e.hidden&&!e.closest('[hidden]'))))},{s:selector,visible:options.visible||selector.includes(':not([hidden])')}))return;await new Promise(r=>setTimeout(r,100))}throw new Error('panel selector timeout '+selector)},async $$eval(selector,fn){return evaluate((s,source)=>Function(`return (${source})`)()([...document.querySelectorAll(s)]),selector,fn.toString())}}
  const click=async(selector)=>{
    for(let i=0;i<5;i++){
      const b=await evaluate(s=>{const e=document.querySelector(s);e?.scrollIntoView({block:'center'});const r=e?.getBoundingClientRect();if(!r)return null;const x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return {x,y,width:r.width,height:r.height,ok:!e.hidden&&!e.disabled&&!e.closest('[hidden]')&&r.width>0&&r.height>0&&(h===e||e.contains(h))}},selector)
      if(!b?.ok)continue
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:b.x,y:b.y})
      await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:b.x,y:b.y,button:'left',clickCount:1})
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:b.x,y:b.y,button:'left',clickCount:1})
      clicks++;trace.push({type:'click',selector});return
    }
    throw new Error('panel control hidden or covered '+selector+' '+JSON.stringify(await evaluate(s=>{const e=document.querySelector(s);return e?{html:e.outerHTML,hidden:e.hidden,disabled:e.disabled,ancestor:e.closest('[hidden]')?.outerHTML?.slice(0,250),rect:(()=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})(),visibility:getComputedStyle(e).visibility}:null},selector)))
  }
  const fill=async(selector,value)=>{
    const focused=await evaluate(s=>{const e=document.querySelector(s);if(!e||e.hidden||e.closest('[hidden]'))return false;e.focus();e.select?.();return document.activeElement===e},selector)
    assert.ok(focused,'panel input not focusable '+selector)
    await cdp.send('Input.insertText',{text:value});formEdits++;trace.push({type:'formEdit',selector,value})
  }
  return {driver,click,fill}
}
const fill=async(page,selector,value)=>{await page.locator(selector).fill(value);formEdits++;trace.push({type:'formEdit',selector,value})}
const recordToolbarEntry=()=>{clicks++;trace.push({type:'chromeAction',action:'open-picker-via-extension-entry',countedAsOneUserClick:true})}
const wait=async(page,fn,...args)=>page.waitForFunction(fn,{polling:100,timeout:20000},...args)
const treeHash=dir=>{
  const hash=crypto.createHash('sha256')
  const walk=d=>{for(const name of readdirSync(d).sort()){const path=join(d,name),st=statSync(path);if(st.isDirectory())walk(path);else{hash.update(relative(dir,path));hash.update('\0');hash.update(readFileSync(path));hash.update('\0')}}}
  walk(dir);return hash.digest('hex')
}
const manifest=JSON.parse(readFileSync(join(SRC,'manifest.json'),'utf8'))

try{
  assert.ok(BROWSER,`Chrome for Testing unavailable; set BROWSER_PATH. Checked: ${BROWSER_CANDIDATES.join(', ')}`)
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok)})
  const url=`http://127.0.0.1:${server.address().port}/`
  browser=await puppeteer.launch({executablePath:BROWSER,headless:process.env.AF23_HEADLESS==='1',userDataDir:profile,args:[`--disable-extensions-except=${SRC}`,`--load-extension=${SRC}`,'--no-first-run','--no-default-browser-check']})
  const worker=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background/main.js'))
  const ext=new URL(worker.url()).host
  const control=await browser.newPage();await control.goto(`chrome-extension://${ext}/ui/report/report.html#view=settings`)
  const savedTask=async name=>control.evaluate(async name=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));return (await s.getTasks()).find(t=>t.name===name)||null},name)

  // Fixed scalar workflow: enter picker, select a value, try, save, then confirm
  // the saved task and first history value through persisted extension storage/UI.
  let started=performance.now();clicks=0;formEdits=0;transitions=0;trace.length=0
  const source=await browser.newPage();await source.goto(url,{waitUntil:'load'})
  const tabId=await control.evaluate(async u=>(await chrome.tabs.query({url:u})).at(-1).id,url)
  recordToolbarEntry()
  const entered=await control.evaluate(async id=>chrome.runtime.sendMessage({type:'ENTER_PICK',purpose:'task',tabId:id,frameId:0}),tabId)
  assert.equal(entered?.ok,true,`single picker entry rejected: ${JSON.stringify(entered)}`)
  const picker=await browser.newPage();await picker.goto(`chrome-extension://${ext}/ui/picker/picker.html?tabId=${tabId}`)
  await source.waitForSelector('[data-af-done]',{visible:true})
  await click(source,'#scalar');await click(source,'[data-af-done]');transitions++;trace.push({type:'transition',to:'picker form'})
  await picker.waitForSelector('#name',{visible:true});await click(picker,'#name');await fill(picker,'#name','Baseline 單值任務')
  await click(picker,'#test-now');await wait(picker,()=>!document.querySelector('#test-now').disabled&&document.querySelector('#preview')?.textContent.trim()==='42')
  await click(picker,'#save');await wait(picker,()=>document.querySelector('#saved-feedback [data-saved-first]')?.dataset.state==='ok');transitions++;trace.push({type:'transition',to:'saved first result'})
  const scalar=await savedTask('Baseline 單值任務');assert.ok(scalar,'single task persisted')
  const scalarRecord=await control.evaluate(async id=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));const dates=await s.listDates();return (await Promise.all(dates.map(d=>s.getRecordsByDate(d)))).flat().find(r=>r.taskId===id||r.taskId.startsWith(id+'#'))||null},scalar.id)
  assert.equal(scalarRecord?.value,42,'first scalar capture persisted')
  const scalarEvidence={flow:'single-value-create-preview-save-first-result',clicks,formEdits,screenTransitions:transitions,elapsedMs:+(performance.now()-started).toFixed(2),trace:[...trace],persistedValue:scalarRecord.value,status:'PASS'}
  await picker.close();await source.close()

  let groupEvidence
  if(LABEL==='baseline'&&process.env.AF23_BASELINE_TWO_SINGLES==='1'){
    // Optional reference only: compare these values via two separate tasks;
    // this does not replace the baseline's actual two-group path below.
    started=performance.now();clicks=0;formEdits=0;transitions=0;trace.length=0
    const oldResults=[]
    for(const [label,selector,value] of [['第一組','#group-a',101],['第二組','#group-b',202]]){
      const page=await browser.newPage();await page.goto(url,{waitUntil:'load'})
      const id=await control.evaluate(async u=>(await chrome.tabs.query({url:u})).at(-1).id,url)
      recordToolbarEntry()
      const response=await control.evaluate(async id=>chrome.runtime.sendMessage({type:'ENTER_PICK',purpose:'task',tabId:id,frameId:0}),id)
      assert.equal(response?.ok,true,`baseline single entry rejected ${label}`)
      const form=await browser.newPage();await form.goto(`chrome-extension://${ext}/ui/picker/picker.html?tabId=${id}`)
      await page.waitForSelector('[data-af-done]',{visible:true});await click(page,selector);await click(page,'[data-af-done]');transitions++;trace.push({type:'transition',to:'single-task form',group:label})
      await form.waitForSelector('#name',{visible:true});await click(form,'#name');await fill(form,'#name',`Baseline ${label}`)
      await click(form,'#test-now');await wait(form,()=>!document.querySelector('#test-now').disabled&&Boolean(document.querySelector('#preview')?.textContent.trim()))
      await click(form,'#save');await wait(form,()=>document.querySelector('#saved-feedback [data-saved-first]')?.dataset.state==='ok');transitions++;trace.push({type:'transition',to:'saved first result',group:label})
      const task=await savedTask(`Baseline ${label}`);assert.ok(task,`baseline ${label} task persisted`)
      const record=await control.evaluate(async id=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));const dates=await s.listDates();return (await Promise.all(dates.map(d=>s.getRecordsByDate(d)))).flat().find(r=>r.taskId===id||r.taskId.startsWith(id+'#'))||null},task.id)
      assert.equal(record?.value,value,`baseline ${label} result persisted`);oldResults.push({name:label,value:record.value})
      await page.close();await form.close()
    }
    groupEvidence={flow:'baseline-equivalent-two-values-as-two-single-tasks',clicks,formEdits,screenTransitions:transitions,elapsedMs:+(performance.now()-started).toFixed(2),trace:[...trace],groupCount:2,persistedResults:oldResults,status:'PASS'}
  }else{
  // Exactly two independently named groups. All value selection, Done, name
  // confirmation, finish, preview, and save actions use visible controls.
  started=performance.now();clicks=0;formEdits=0;transitions=0;trace.length=0
  const groupSource=await browser.newPage();await groupSource.goto(url,{waitUntil:'load'})
  const groupTab=await control.evaluate(async u=>(await chrome.tabs.query({url:u})).at(-1).id,url)
  await control.evaluate(async({id,pageUrl})=>chrome.storage.session.set({[`panel:${id}`]:{kind:'new',batch:true,tabId:id,url:pageUrl}}),{id:groupTab,pageUrl:url})
  await control.evaluate(async id=>{await chrome.sidePanel.setOptions({tabId:id,path:'ui/picker/picker.html',enabled:true});await chrome.tabs.update(id,{active:true})},groupTab)
  await control.evaluate(id=>{const b=document.createElement('button');b.id='open-real-side-panel';b.textContent='Open picker panel';b.style.cssText='position:fixed;left:18px;top:18px;width:220px;height:56px;z-index:999999';b.onclick=async()=>{try{await chrome.sidePanel.open({tabId:id});b.dataset.opened='true'}catch(e){b.dataset.error=String(e)}};document.body.append(b)},groupTab)
  await clickWithoutFocus(control,'#open-real-side-panel');await wait(control,()=>document.querySelector('#open-real-side-panel')?.dataset.opened==='true')
  const groupTarget=await browser.waitForTarget(t=>t.url().includes('/ui/picker/picker.html'),{timeout:15000})
  const {driver:groupPicker,click:clickGroup,fill:fillGroup}=await makePanelDriver(groupTarget)
  await groupPicker.waitForFunction(()=>!document.querySelector('#group-draft-section')?.hidden,{timeout:15000})
  await groupPicker.waitForSelector('#group-start-first:not([hidden])',{timeout:15000})
  await clickGroup('#group-start-first');await groupPicker.waitForSelector('#group-name-editor:not([hidden])')
  await clickGroup('#group-name');await fillGroup('#group-name','第一組');await clickGroup('#group-name-confirm')
  await groupSource.waitForSelector('[data-af-done]',{visible:true});await click(groupSource,'#group-a');await click(groupSource,'[data-af-done]');transitions++;trace.push({type:'transition',to:'group draft'})
  await wait(groupPicker,()=>document.querySelector('[data-group-row] [data-group-value]'))
  await clickGroup('#group-add');await groupPicker.waitForSelector('#group-name-editor:not([hidden])')
  await clickGroup('#group-name');await fillGroup('#group-name','第二組');await clickGroup('#group-name-confirm')
  await groupSource.waitForSelector('[data-af-done]',{visible:true});await click(groupSource,'#group-b');await click(groupSource,'[data-af-done]');transitions++;trace.push({type:'transition',to:'group draft'})
  await wait(groupPicker,()=>document.querySelectorAll('[data-group-row]').length===2&&document.querySelectorAll('[data-group-row] [data-group-value]').length===2)
  assert.deepEqual(await groupPicker.$$eval('[data-group-row]',rows=>rows.map(r=>r.querySelector('[data-group-name]')?.textContent.trim())),['第一組','第二組'])
  await clickGroup('#group-finish');transitions++;trace.push({type:'transition',to:'batch settings'})
  await groupPicker.waitForSelector('#batch-section:not([hidden])',{timeout:12000})
  const batchNames=await groupPicker.$$eval('#batch-list [data-batch-name]',els=>els.map(e=>e.value))
  assert.equal(batchNames.length,2,'exactly two task names presented')
  const batchAction=await groupPicker.evaluate(()=>{const e=document.querySelector('#test-now'),r=e?.getBoundingClientRect();return {actionBarHidden:document.querySelector('.action-bar')?.hidden,buttonHidden:e?.hidden,disabled:e?.disabled,visible:Boolean(r&&r.width>0&&r.height>0),ancestorHidden:e?.closest('[hidden]')?.className||null}})
  if(!batchAction.visible){
    const blocked={label:LABEL,source:{path:SRC,manifestVersion:manifest.version,srcSha256:treeHash(SRC)},browser:BROWSER,baselineCommit:BASELINE,flows:[scalarEvidence,{flow:'exactly-two-groups-create-preview-save-first-results',clicks,formEdits,screenTransitions:transitions,elapsedMs:+(performance.now()-started).toFixed(2),trace:[...trace],groupCount:2,batchNames,batchAction,status:'BLOCKED'}],status:'BLOCKED'}
    const out=process.env.AF23_OUTPUT?resolve(process.env.AF23_OUTPUT):join(ROOT,'work','af23-c5-baseline-baseline-groups.json')
    mkdirSync(join(out,'..'),{recursive:true});writeFileSync(out,JSON.stringify(blocked,null,2)+'\n');console.log(JSON.stringify(blocked,null,2))
    const error=new Error('baseline group path reached batch settings but visible test/save controls are hidden')
    error.expectedBaselineBlock=true
    throw error
  }
  await clickGroup('#test-now')
  await wait(groupPicker,()=>{const rows=[...document.querySelectorAll('#batch-list [data-batch-result]')];return rows.length===2&&rows.every(e=>e.textContent.trim()&&e.textContent.trim()!=='—')&&!document.querySelector('#test-now').disabled})
  await clickGroup('#save');await wait(control,async names=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));const tasks=await s.getTasks();const selected=tasks.filter(t=>names.includes(t.name));if(selected.length!==2)return false;const dates=await s.listDates(),records=(await Promise.all(dates.map(d=>s.getRecordsByDate(d)))).flat();return selected.every(t=>records.some(r=>r.taskId===t.id||r.taskId.startsWith(t.id+'#')))},batchNames)
  transitions++;trace.push({type:'transition',to:'saved first results'})
  const groups=await control.evaluate(async names=>{const s=await import(chrome.runtime.getURL('shared/storage.js'));return Promise.all(names.map(async name=>{const task=(await s.getTasks()).find(t=>t.name===name);if(!task)return {name,task:null,records:[]};const records=(await Promise.all((await s.listDates()).map(d=>s.getRecordsByDate(d)))).flat().filter(r=>r.taskId===task.id||r.taskId.startsWith(task.id+'#'));return {name,task,records}}))},batchNames)
  assert.equal(groups.length,2);assert.ok(groups.every(g=>g.task),'both group tasks persisted');assert.ok(groups.every(g=>g.records.length>0),'each group has a first result')
  groupEvidence={flow:'exactly-two-groups-create-preview-save-first-results',clicks,formEdits,screenTransitions:transitions,elapsedMs:+(performance.now()-started).toFixed(2),trace:[...trace],groupCount:groups.length,persistedResults:groups.map(g=>({name:g.name,value:g.records[0]?.value})),status:'PASS'}
  }

  const evidence={label:LABEL,source:{path:SRC,manifestVersion:manifest.version,srcSha256:treeHash(SRC)},browser:BROWSER,baselineCommit:LABEL==='baseline'?BASELINE:null,flows:[scalarEvidence,groupEvidence],status:'PASS'}
  const defaultOutput=LABEL==='baseline'?join(ROOT,'work','af23-c5-baseline-baseline-two-singles-reference.json'):join(ROOT,'work',`af23-c5-baseline-${LABEL}.json`)
  const out=process.env.AF23_OUTPUT?resolve(process.env.AF23_OUTPUT):defaultOutput
  mkdirSync(join(out,'..'),{recursive:true});writeFileSync(out,JSON.stringify(evidence,null,2)+'\n')
  console.log(JSON.stringify(evidence,null,2))
}catch(error){console.error(error);if(!error.expectedBaselineBlock)process.exitCode=1}
finally{if(browser)await browser.close();server.closeAllConnections?.();if(server.listening)await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:200})}
