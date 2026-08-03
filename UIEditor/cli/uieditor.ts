#!/usr/bin/env node
/**
 * UIEditor CLI — 非 UI 批处理入口（与网页共用 PSD / Prefab 核心逻辑）
 *
 * 用法：
 *   npm run cli -- import-psd --psd <file> --project <dir> [--name <name>] [--force]
 *   npm run cli -- export-prefab --project <dir> --ui <json> --out <dir> [--force]
 *   npm run cli -- export-ui --project <dir> --ui <json> --out <file>
 *   npm run cli -- validate-ui --ui <json>
 */
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { exportCocosPrefabCore } from '../src/utils/cocosPrefab'
import { sanitizeFsName } from '../src/utils/fsName'
import { parsePsdBuffer } from '../src/utils/psd'
import { normalizeUIData, serializeForDisk } from '../src/utils/uiNode'

type Flags = Record<string, string | boolean>

function printHelp(): void {
  console.log(`UIEditor CLI — Cocos-like UI 批处理工具

用法:
  uieditor <command> [options]

命令:
  import-psd      解析 PSD，写入项目 {名}/UI/*.png 与 {名}/{名}.json
  export-prefab   将 UI JSON 导出为 Creator 3.8 Prefab 资源包
  export-ui       将 UI JSON 规范化后另存
  validate-ui     校验 UI JSON 结构合法性

选项:
  import-psd:
    --psd <path>         PSD 文件（必填）
    --project <dir>      项目根目录（必填）
    --name <name>        界面/目录名（默认取 PSD 文件名）
    --width <n>          Root 宽（设计分辨率，默认 1366）
    --height <n>         Root 高（设计分辨率，默认 768）
    --force              覆盖已存在的同名目录

  export-prefab:
    --project <dir>      项目根目录（必填，用于解析 framePath）
    --ui <path>          UI JSON（相对 project 或绝对路径，必填）
    --out <dir>          导出根目录（必填）
    --force              覆盖已存在的同名导出包

  export-ui:
    --project <dir>      项目根目录（可选；ui 为相对路径时建议提供）
    --ui <path>          源 UI JSON（必填）
    --out <path>         目标 JSON 文件（必填）

  validate-ui:
    --ui <path>          UI JSON（必填）

  -h, --help             显示帮助
`)
}

function parseArgv(argv: string[]): { command: string | null; flags: Flags } {
  const flags: Flags = {}
  let command: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-h' || a === '--help') {
      flags.help = true
      continue
    }
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        flags[key] = next
        i += 1
      } else {
        flags[key] = true
      }
      continue
    }
    if (!command) command = a
    else throw new Error(`未知参数：${a}`)
  }
  return { command, flags }
}

function flagString(flags: Flags, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

function flagBool(flags: Flags, key: string): boolean {
  return flags[key] === true || flags[key] === 'true'
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
}

function resolveMaybe(base: string | undefined, p: string): string {
  if (path.isAbsolute(p)) return path.resolve(p)
  if (base) return path.resolve(base, p)
  return path.resolve(p)
}

async function loadUiJson(filePath: string) {
  const text = await readFile(filePath, 'utf8')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`非法 JSON：${filePath}`)
  }
  const root = normalizeUIData(raw)
  if (!root) throw new Error(`不是合法的 UI 节点 JSON：${filePath}`)
  return root
}

async function cmdImportPsd(flags: Flags): Promise<void> {
  const psdPath = flagString(flags, 'psd')
  const project = flagString(flags, 'project')
  if (!psdPath || !project) {
    throw new Error('import-psd 需要 --psd 与 --project')
  }
  const absPsd = path.resolve(psdPath)
  const absProject = path.resolve(project)
  if (!(await pathExists(absPsd))) throw new Error(`PSD 不存在：${absPsd}`)
  if (!(await pathExists(absProject))) throw new Error(`项目目录不存在：${absProject}`)

  const nameOpt = flagString(flags, 'name')
  const widthOpt = flagString(flags, 'width')
  const heightOpt = flagString(flags, 'height')
  const buf = await readFile(absPsd)
  const parsed = await parsePsdBuffer(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    path.basename(absPsd),
    {
      baseNameOverride: nameOpt,
      rootWidth: widthOpt ? Number(widthOpt) : undefined,
      rootHeight: heightOpt ? Number(heightOpt) : undefined,
    },
  )

  const packDir = path.join(absProject, parsed.folderPath)
  if (await pathExists(packDir)) {
    if (!flagBool(flags, 'force')) {
      throw new Error(`目标已存在：${packDir}（使用 --force 覆盖）`)
    }
    await rm(packDir, { recursive: true, force: true })
  }

  await mkdir(path.join(absProject, parsed.uiFolderPath), { recursive: true })
  for (const img of parsed.images) {
    const out = path.join(absProject, img.relativePath)
    await ensureParentDir(out)
    await writeFile(out, img.bytes)
  }
  const jsonOut = path.join(absProject, parsed.jsonPath)
  await writeFile(jsonOut, parsed.jsonContent, 'utf8')

  console.log(
    `PSD 导入完成：${parsed.jsonPath}（${parsed.layerCount} 张图，PSD ${parsed.documentWidth}×${parsed.documentHeight}，Root ${parsed.rootWidth}×${parsed.rootHeight}）`,
  )
}

async function cmdExportPrefab(flags: Flags): Promise<void> {
  const project = flagString(flags, 'project')
  const ui = flagString(flags, 'ui')
  const out = flagString(flags, 'out')
  if (!project || !ui || !out) {
    throw new Error('export-prefab 需要 --project、--ui 与 --out')
  }
  const absProject = path.resolve(project)
  const absOut = path.resolve(out)
  const absUi = resolveMaybe(absProject, ui)
  if (!(await pathExists(absProject))) throw new Error(`项目目录不存在：${absProject}`)
  if (!(await pathExists(absUi))) throw new Error(`UI JSON 不存在：${absUi}`)

  const root = await loadUiJson(absUi)
  const baseName =
    sanitizeFsName(path.basename(absUi).replace(/\.json$/i, '')) || 'ui'
  const packDir = path.join(absOut, baseName)
  if (await pathExists(packDir)) {
    if (!flagBool(flags, 'force')) {
      throw new Error(`导出目录已存在：${packDir}（使用 --force 覆盖）`)
    }
    await rm(packDir, { recursive: true, force: true })
  }
  await mkdir(path.join(packDir, 'UI'), { recursive: true })

  const result = await exportCocosPrefabCore({
    baseName,
    root,
    readImageBytes: async (rel) => {
      const full = path.join(absProject, rel)
      try {
        const data = await readFile(full)
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      } catch {
        return null
      }
    },
    fs: {
      writeText: async (relativePath, text) => {
        const full = path.join(absOut, relativePath)
        await ensureParentDir(full)
        await writeFile(full, text, 'utf8')
      },
      writeBinary: async (relativePath, data) => {
        const full = path.join(absOut, relativePath)
        await ensureParentDir(full)
        await writeFile(full, data)
      },
    },
  })

  console.log(`Prefab 导出完成：${path.join(absOut, result.prefabPath)}（${result.imageCount} 张图片）`)
}

async function cmdExportUi(flags: Flags): Promise<void> {
  const ui = flagString(flags, 'ui')
  const out = flagString(flags, 'out')
  if (!ui || !out) throw new Error('export-ui 需要 --ui 与 --out')
  const project = flagString(flags, 'project')
  const absUi = resolveMaybe(project ? path.resolve(project) : undefined, ui)
  const absOut = path.resolve(out)
  const root = await loadUiJson(absUi)
  await ensureParentDir(absOut)
  await writeFile(absOut, `${serializeForDisk(root)}\n`, 'utf8')
  console.log(`UI JSON 已导出：${absOut}`)
}

async function cmdValidateUi(flags: Flags): Promise<void> {
  const ui = flagString(flags, 'ui')
  if (!ui) throw new Error('validate-ui 需要 --ui')
  const absUi = path.resolve(ui)
  const root = await loadUiJson(absUi)
  let nodeCount = 0
  const walk = (n: typeof root) => {
    nodeCount += 1
    n.children.forEach(walk)
  }
  walk(root)
  console.log(`校验通过：${absUi}（根节点 "${root.name}"，共 ${nodeCount} 个节点）`)
}

async function main(): Promise<void> {
  const { command, flags } = parseArgv(process.argv.slice(2))
  if (flags.help || !command) {
    printHelp()
    if (!command && !flags.help) process.exitCode = 1
    return
  }

  switch (command) {
    case 'import-psd':
      await cmdImportPsd(flags)
      break
    case 'export-prefab':
      await cmdExportPrefab(flags)
      break
    case 'export-ui':
      await cmdExportUi(flags)
      break
    case 'validate-ui':
      await cmdValidateUi(flags)
      break
    default:
      throw new Error(`未知命令：${command}（使用 --help 查看用法）`)
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
