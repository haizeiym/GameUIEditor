#!/usr/bin/env node
/**
 * bin 入口：优先跑打包产物 dist-cli/uieditor.js；
 * 若不存在则回退 tsx 直接执行源码（本地开发）。
 */
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const built = join(root, 'dist-cli', 'uieditor.js')
const source = join(here, 'uieditor.ts')

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

const args = process.argv.slice(2)
const useBuilt = await exists(built)
const child = useBuilt
  ? spawn(process.execPath, [built, ...args], { stdio: 'inherit' })
  : spawn(process.execPath, ['--import', 'tsx', source, ...args], {
      stdio: 'inherit',
      cwd: root,
    })

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
