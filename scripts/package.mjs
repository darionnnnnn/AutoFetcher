import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, relative, dirname, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

export function hashesOf(root) {
  const hashes = {}
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path = join(dir,entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) hashes[relative(root,path).split('\\').join('/')] = createHash('sha256').update(readFileSync(path)).digest('hex')
      else throw new Error(`Unsupported package entry: ${path}`)
    }
  }
  walk(root)
  return hashes
}

export function createPackage(source, destination) {
  source = resolve(source); destination = resolve(destination)
  const nested = relative(source, destination)
  if (!nested || (!nested.startsWith(`..${sep}`) && nested !== '..' && !isAbsolute(nested))) throw new Error('交付目錄不得位於來源目錄內。')
  if (existsSync(`${destination}.sha256.json`)) throw new Error('交付雜湊清單已存在；請使用新的目錄。')
  if (existsSync(destination)) throw new Error('交付目錄已存在；請使用新的目錄，避免覆蓋已安裝版本。')
  const manifest = JSON.parse(readFileSync(join(source,'manifest.json'),'utf8'))
  const files = hashesOf(source)
  if (Object.keys(files).length === 0) throw new Error('Empty extension package')
  mkdirSync(dirname(destination),{recursive:true})
  cpSync(source,destination,{recursive:true,errorOnExist:true,force:false})
  const actual = hashesOf(destination)
  if (JSON.stringify(files)!==JSON.stringify(actual)) throw new Error('交付內容與src不一致')
  const evidence = { version:manifest.version, files }
  writeFileSync(`${destination}.sha256.json`,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'})
  return evidence
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('用法：node scripts/package.mjs <新的交付目錄>')
  const root = resolve(dirname(fileURLToPath(import.meta.url)),'..')
  const result = createPackage(join(root,'src'),process.argv[2])
  console.log(`Packaged AutoFetcher ${result.version}: ${Object.keys(result.files).length} verified files`)
}
