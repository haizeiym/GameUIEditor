/**
 * 网页发布整数版本号（v1 / v2 / …），存于 web-build.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'web-build.json')

export function readWebBuildVersion() {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const n = Number(data.version)
    return Number.isInteger(n) && n >= 1 ? n : 1
  } catch {
    return 1
  }
}

/** 构建成功后 +1，供下次打包使用 */
export function bumpWebBuildVersion() {
  const current = readWebBuildVersion()
  const next = current + 1
  writeFileSync(file, `${JSON.stringify({ version: next }, null, 2)}\n`, 'utf8')
  return { current, next }
}
