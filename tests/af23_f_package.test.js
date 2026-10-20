import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPackage,hashesOf } from '../scripts/package.mjs'

test('AC-F5/F6 交付檔案hash逐項相同且不覆寫已存在安裝目錄',()=>{
  const root=mkdtempSync(join(tmpdir(),'af23-package-'))
  try {
    const source=join(root,'src'),dest=join(root,'release')
    mkdirSync(join(source,'shared'),{recursive:true})
    writeFileSync(join(source,'manifest.json'),JSON.stringify({version:'0.22.0'}))
    writeFileSync(join(source,'shared/value.js'),'export const value = "測試"\n')
    assert.throws(()=>createPackage(source,join(source,'nested')),/來源目錄/)
    writeFileSync(`${dest}.sha256.json`,'preserve evidence')
    assert.throws(()=>createPackage(source,dest),/雜湊清單已存在/)
    assert.equal(readFileSync(`${dest}.sha256.json`,'utf8'),'preserve evidence')
    rmSync(`${dest}.sha256.json`)
    const result=createPackage(source,dest)
    assert.equal(result.version,'0.22.0')
    assert.equal(Object.keys(result.files).length,2)
    assert.deepEqual(hashesOf(dest),hashesOf(source))
    writeFileSync(join(dest,'manifest.json'),'preserve existing installation')
    assert.throws(()=>createPackage(source,dest),/已存在/)
    assert.equal(readFileSync(join(dest,'manifest.json'),'utf8'),'preserve existing installation')
  } finally {rmSync(root,{recursive:true,force:true})}
})
