#!/usr/bin/env node
/**
 * 构建后在 dist/ 根目录写入入口，跳转到当前整数版本目录 dist/v{n}/，并 +1 版本号。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bumpWebBuildVersion, readWebBuildVersion } from './web-build-version.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = readWebBuildVersion()
const basePath = `/v${version}/`
const distRoot = join(root, 'dist')

await mkdir(distRoot, { recursive: true })

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
    <meta http-equiv="Pragma" content="no-cache" />
    <title>UI Editor</title>
    <script>location.replace(${JSON.stringify(basePath)})</script>
    <meta http-equiv="refresh" content="0;url=${basePath}" />
  </head>
  <body>
    <p>Redirecting to <a href="${basePath}">${basePath}</a> …</p>
  </body>
</html>
`

await writeFile(join(distRoot, 'index.html'), html, 'utf8')
await writeFile(
  join(distRoot, 'version.json'),
  `${JSON.stringify({ version, base: basePath, builtAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
)

const { next } = bumpWebBuildVersion()
console.log(`[dist] root → ${basePath}（本次 v${version}，下次将使用 v${next}）`)
