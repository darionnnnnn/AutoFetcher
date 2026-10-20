// AC-F5/F6: load the baseline, then replace only this test's unpacked directory.
import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findBrowser, ROOT } from './browser-path.mjs'
import { createPackage, hashesOf } from '../../scripts/package.mjs'

const root=mkdtempSync(join(tmpdir(),'af23-upgrade-'))
const install=join(root,'installed')
const base='75ed288ee99bce93bb70c10f7c7ef577dc587c9d'
const expectedVersion=JSON.parse(readFileSync(resolve(ROOT,'src/manifest.json'),'utf8')).version
let browser
try {
  const archive=join(root,'baseline.tar')
  execFileSync('git',['archive','--output',archive,base,'src'],{cwd:ROOT})
  execFileSync('tar',['-xf',archive,'-C',root])
  cpSync(join(root,'src'),install,{recursive:true})
  browser=await puppeteer.launch({executablePath:findBrowser(),headless:false,userDataDir:join(root,'profile'),args:[`--disable-extensions-except=${install}`,`--load-extension=${install}`,'--no-first-run','--no-default-browser-check']})
  const oldWorker=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background/main.js'))
  const id=new URL(oldWorker.url()).host
  let page=await browser.newPage()
  await page.goto(`chrome-extension://${id}/ui/report/report.html#view=settings`)
  const before=await page.evaluate(async()=>{
    const s=await import(chrome.runtime.getURL('shared/storage.js'))
    await s.init()
    await s.saveTask({id:'upgrade-fixture',name:'升級保留任務',url:'https://fixture.invalid/value',enabled:false,mode:'number',locator:{css:'#value'},spec:{strategy:'auto'},schedule:{type:'daily',times:['09:30'],weekdays:[1]}})
    await s.appendRecord('2026-10-20',{taskId:'upgrade-fixture',slot:'2026-10-20T09:30',capturedAt:'2026-10-20T01:30:00Z',value:123.4,raw:'123.4',status:'ok'})
    const io=await import(chrome.runtime.getURL('shared/settings-io.js'))
    return {id:chrome.runtime.id,version:chrome.runtime.getManifest().version,task:await s.getTask('upgrade-fixture'),records:await s.getRecordsByDate('2026-10-20'),backup:await io.exportSettings()}
  })
  assert.equal(before.version,'0.21.0')
  await browser.close();browser=null
  rmSync(install,{recursive:true})
  const packaged=createPackage(resolve(ROOT,'src'),install)
  assert.deepEqual(packaged.files,hashesOf(resolve(ROOT,'src')))
  browser=await puppeteer.launch({executablePath:findBrowser(),headless:false,userDataDir:join(root,'profile'),args:[`--disable-extensions-except=${install}`,`--load-extension=${install}`,'--no-first-run','--no-default-browser-check']})
  await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background/main.js'),{timeout:20000})
  page=await browser.newPage()
  await page.goto(`chrome-extension://${id}/ui/report/report.html#view=settings`)
  const upgraded=await page.evaluate(async()=>{
    const s=await import(chrome.runtime.getURL('shared/storage.js'))
    return {id:chrome.runtime.id,version:chrome.runtime.getManifest().version,task:await s.getTask('upgrade-fixture'),records:await s.getRecordsByDate('2026-10-20')}
  })
  assert.equal(upgraded.id,before.id)
  assert.equal(upgraded.version,expectedVersion)
  assert.deepEqual(upgraded.task,before.task,'upgrade preserves task before any backup restoration')
  assert.deepEqual(upgraded.records,before.records,'upgrade preserves history before any backup restoration')
  const after=await page.evaluate(async backup=>{
    const s=await import(chrome.runtime.getURL('shared/storage.js'))
    const io=await import(chrome.runtime.getURL('shared/settings-io.js'))
    await s.saveTask({id:'post-upgrade-task',name:'新增任務不得被備份抹除',url:'https://fixture.invalid/new',enabled:false,mode:'number',locator:{css:'#value'},spec:{strategy:'auto'},schedule:{type:'daily',times:['09:30'],weekdays:[1]}})
    await io.importSettings(backup)
    const legacy=JSON.parse(backup);legacy.data.schemaVersion=3
    legacy.data.tasks=legacy.data.tasks.map(task=>({...task,id:'schema3-fixture',name:'schema3 import'}))
    await io.importSettings(JSON.stringify(legacy))
    const exporter=await import(chrome.runtime.getURL('shared/export.js'))
    const history=JSON.parse((await exporter.buildExport({from:'2026-10-20',to:'2026-10-20',format:'json'})).content)
    return {id:chrome.runtime.id,version:chrome.runtime.getManifest().version,task:await s.getTask('upgrade-fixture'),records:await s.getRecordsByDate('2026-10-20'),history,newTask:await s.getTask('post-upgrade-task'),legacy:await s.getTask('schema3-fixture'),schema:await s.getSchemaVersion()}
  },before.backup)
  assert.equal(after.id,before.id)
  assert.equal(after.version,expectedVersion)
  assert.deepEqual(after.task,before.task)
  assert.deepEqual(after.records,before.records)
  assert.deepEqual(after.history.tasks['upgrade-fixture'].records,before.records)
  assert.equal(after.schema,4)
  assert.equal(after.newTask.id,'post-upgrade-task')
  assert.equal(after.legacy.id,'schema3-fixture')
  await browser.close();browser=null
  execFileSync(process.execPath,[resolve(ROOT,'tests/smoke/af22_g1_group_flow.mjs')],{
    cwd:ROOT,env:{...process.env,AF23_EXTENSION_PATH:install,AF23_UPGRADE_PROFILE:join(root,'profile')},stdio:'inherit',timeout:360000
  })
  const evidence={test:'AC-F5/F6',base,version:after.version,sameExtensionId:true,upgradedCreateRepairCore:true,records:after.records.length,settingsRoundtrip:true,fileCount:Object.keys(packaged.files).length,hashes:packaged.files,status:'passed'}
  if(process.env.AF23_RELEASE_EVIDENCE)writeFileSync(process.env.AF23_RELEASE_EVIDENCE,JSON.stringify(evidence,null,2)+'\n')
  console.log(JSON.stringify({...evidence,hashes:undefined}))
} catch(error) {console.error(error);process.exitCode=1}
finally {if(browser)await browser.close();rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:200})}
