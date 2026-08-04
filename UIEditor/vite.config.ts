import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
  plugins: [vue(), tailwindcss()],
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
