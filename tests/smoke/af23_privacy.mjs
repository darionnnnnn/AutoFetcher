// Real MV3 worker/page network and diagnostic boundary; only localhost fixtures.
import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import http from 'node:http'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {findBrowser,ROOT} from './browser-path.mjs'
const secrets=['AF23_REAL_PASSWORD_SENTINEL','AF23_QUERY_TOKEN_SENTINEL','AF23_HIDDEN_AREA_SENTINEL']
const baseline=JSON.parse(execFileSync('git',['show','75ed288:src/manifest.json'],{cwd:ROOT,encoding:'utf8'}))
const current=JSON.parse(readFileSync(resolve(ROOT,'src/manifest.json')))
for(const key of ['permissions','host_permissions','optional_permissions','optional_host_permissions'])assert.deepEqual(current[key],baseline[key],key+' unchanged')
const profile=mkdtempSync(join(tmpdir(),'af23-privacy-'))
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(`<!doctype html><title>Privacy fixture</title><p id="selected">42</p><input id="user"><input id="pass" type="password" value="${secrets[0]}"><button id="submit">登入</button><textarea hidden>${secrets[2]}</textarea>` )})
let browser
const network=[],consoleEntries=[],sessions=[]
try{
 await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)})
 const origin=`http://127.0.0.1:${server.address().port}`,url=origin+'/login?token='+secrets[1]
 browser=await puppeteer.launch({executablePath:findBrowser(),headless:process.env.AF23_HEADLESS==='1',userDataDir:profile,args:[`--disable-extensions-except=${resolve(ROOT,'src')}`,`--load-extension=${resolve(ROOT,'src')}`,'--no-first-run','--no-default-browser-check']})
 const attached=new Set()
 const attach=async target=>{
  if(attached.has(target)||!['page','service_worker'].includes(target.type()))return
  attached.add(target)
  const s=await target.createCDPSession();sessions.push(s)
  s.on('Network.requestWillBeSent',event=>network.push({targetType:target.type(),targetURL:target.url(),url:event.request.url,body:event.request.postData||'',initiator:event.initiator.type}))
  s.on('Runtime.consoleAPICalled',event=>consoleEntries.push({targetType:target.type(),args:event.args.map(arg=>arg.value??arg.description)}))
  await Promise.all([s.send('Network.enable'),s.send('Runtime.enable')])
 }
 browser.on('targetcreated',target=>attach(target).catch(error=>consoleEntries.push({observerError:String(error)})))
 const worker=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background/main.js'))
 await attach(worker)
 const id=new URL(worker.url()).host,p=await browser.newPage();await attach(p.target())
 await p.goto(`chrome-extension://${id}/ui/report/report.html#view=settings`)
 // Use the public new-task preview tab option. Attach before navigation so
 // every request during login/extraction is observed, without modifying APIs.
 const sourcePage=await browser.newPage();await attach(sourcePage.target());await sourcePage.goto(url,{waitUntil:'load'})
 const sourceTabId=await p.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,url)
 const result=await p.evaluate(async({origin,url,password,sourceTabId})=>{
  const s=await import(chrome.runtime.getURL('shared/storage.js'))
  const crypto=await import(chrome.runtime.getURL('shared/crypto.js'))
  await s.init()
  await s.saveSite(origin,{enabled:true,failStreak:2,loginUrl:url,username:'fixture-user',passwordEnc:await crypto.encryptSecret(password),selectors:{user:{css:'#user'},pass:{css:'#pass'},submit:{css:'#submit'}},loginCheck:{type:'urlPrefix',value:origin+'/login'},successCheck:{type:'urlPrefix',value:origin+'/success'}})
  const before=await chrome.storage.local.get(null)
  const task={id:'privacy-fixture',name:'Privacy',url,mode:'number',locator:{css:'#missing-target'},spec:{strategy:'auto'},enabled:true,schedule:{type:'daily',times:['09:30'],weekdays:[1]}}
  const response=await chrome.runtime.sendMessage({type:'TEST_TASK',task,tabId:sourceTabId})
  const after=await chrome.storage.local.get(null)
  return {response,before,after,diag:after.diag||[]}
 },{origin,url,password:secrets[0],sourceTabId})
 assert.ok(result.response.status==='error'||result.response.ok===false,'fixture must exercise an error: '+JSON.stringify(result.response))
 const diag=JSON.stringify(result.diag),logs=JSON.stringify(consoleEntries)
 for(const secret of secrets){assert.ok(!diag.includes(secret),'diagnostic secret redacted');assert.ok(!logs.includes(secret),'console secret redacted')}
 const before=result.before,after=result.after;delete before.diag;delete after.diag
 assert.deepEqual(after,before,'interactive login failure leaves formal storage intact')
 // Fetching the selected URL may legitimately carry its query token to that
 // exact site. Never count that authorized source request as telemetry.
 for(const request of network){
  assert.ok(request.url.startsWith(origin+'/')||request.url.startsWith(`chrome-extension://${id}/`)||request.url.startsWith('data:'),'unexpected extension/fixture destination: '+request.url)
  assert.ok(!JSON.stringify(request).includes(secrets[0])&&!JSON.stringify(request).includes(secrets[2]),'credentials/hidden content absent from URLs and bodies')
  if(request.url.includes(secrets[1]))assert.ok(request.url===url,'source token escaped its exact configured source URL')
 }
 assert.ok(network.some(r=>r.url===url),'network observer captured actual source navigation')
 assert.ok(attached.has(worker),'MV3 worker network explicitly observed')
 assert.equal(sourcePage.isClosed(),false,'preview keeps supplied user source tab open')
 const evidence={status:'PASS',permissionsUnchanged:true,workerObserved:true,requestCount:network.length,diagnosticCount:result.diag.length,formalStorageUnchanged:true,sourceTokenPolicy:'exact configured fixture URL only',error:result.response.error,secretSentinelsAbsent:true}
 mkdirSync(resolve(ROOT,'work'),{recursive:true});writeFileSync(resolve(ROOT,'work/af23-privacy.json'),JSON.stringify(evidence,null,2)+'\n');console.log(evidence)
}catch(error){console.error(error);process.exitCode=1}
finally{if(browser)await browser.close();server.closeAllConnections?.();if(server.listening)await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:200})}
