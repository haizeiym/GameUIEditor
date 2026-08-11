import { access, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const accessAsync = promisify(access)

/** 开发态：按绝对路径读本机文件（供脚本 .meta UUID 解析） */
function localFsPlugin(): Plugin {
  return {
    name: 'local-fs-read',
    configureServer(server) {
      server.middlewares.use('/__local_fs', (req, res) => {
        void (async () => {
          try {
            const url = new URL(req.url || '', 'http://localhost')
            const raw = url.searchParams.get('path') || ''
            if (!raw) {
              res.statusCode = 400
              res.end('missing path')
              return
            }
            const abs = resolvePath(raw)
            await accessAsync(abs)
            const text = await readFile(abs, 'utf8')
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
            res.statusCode = 200
            res.end(text)
          } catch (err) {
            res.statusCode = 404
            res.end(err instanceof Error ? err.message : 'not found')
          }
        })()
      })
    },
  }
}

/** 整数发布版本：web-build.json → dist/v1、dist/v2… */
function readWebBuildVersion(): number {
  try {
    const data = JSON.parse(readFileSync(join(__dirname, 'web-build.json'), 'utf8')) as {
      version?: number
    }
    const n = Number(data.version)
    return Number.isInteger(n) && n >= 1 ? n : 1
  } catch {
    return 1
  }
}

const webBuildVersion = readWebBuildVersion()
const versionBase = `/v${webBuildVersion}/`

export default defineConfig(({ command }) => ({
  // 开发用 /；生产资源为 /v{n}/assets/...（见 dist/v{n}/index.html）
  base: command === 'build' ? versionBase : '/',
  plugins: [vue(), tailwindcss(), localFsPlugin()],
  server: {
    port: 5180,
  },
  build: {
    outDir: `dist/v${webBuildVersion}`,
    // 只清空当前版本目录，保留历史 v* 便于回滚
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ['pngjs', 'buffer'],
  },
}))
