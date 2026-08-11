/**
 * 脚本路径校验 + 从同名 .meta 读取 Cocos UUID。
 * 浏览器：项目内相对路径走 File System Access；本机绝对路径走 Vite 开发态 /__local_fs。
 */
import { ElMessage } from 'element-plus'
import { getDirectoryHandleByPath, getFileHandleByPath, readTextFile } from './fs'

const SCRIPT_EXTS = ['.ts', '.js', '.mjs', '.cjs']
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isScriptFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return SCRIPT_EXTS.some((ext) => lower.endsWith(ext))
}

/** 去掉 db:// 前缀，得到可用于查找的路径 */
export function normalizeScriptPath(raw: string): string {
  let p = raw.trim()
  if (!p) return ''
  if (p.startsWith('db://')) p = p.slice('db://'.length)
  // db://assets/... → assets/...
  return p.replace(/\\/g, '/')
}

function metaPathForScript(scriptPath: string): string {
  const p = normalizeScriptPath(scriptPath)
  if (p.toLowerCase().endsWith('.meta')) return p
  return `${p}.meta`
}

function parseUuidFromMetaText(text: string): string | null {
  try {
    const json = JSON.parse(text) as { uuid?: unknown }
    if (typeof json.uuid === 'string' && UUID_RE.test(json.uuid.trim())) {
      return json.uuid.trim().toLowerCase()
    }
  } catch {
    /* ignore */
  }
  return null
}

function isAbsoluteFsPath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)
}

/** 开发态：通过 Vite 中间件读本机文件；Node/CLI 直接读盘 */
async function readLocalFsText(absPath: string): Promise<string | null> {
  if (typeof window !== 'undefined') {
    try {
      const url = `/__local_fs?path=${encodeURIComponent(absPath)}`
      const res = await fetch(url)
      if (res.ok) return await res.text()
      return null
    } catch {
      return null
    }
  }
  try {
    const { readFile } = await import(/* @vite-ignore */ 'node:fs/promises')
    return await readFile(absPath, 'utf8')
  } catch {
    return null
  }
}

export interface ResolveScriptMetaResult {
  ok: boolean
  scriptPath: string
  uuid?: string
  error?: string
}

/**
 * 校验脚本路径并读取 `{script}.meta` 中的 uuid。
 * @param projectRoot 已挂载的项目根（可选，用于相对路径）
 */
export async function resolveScriptMetaUuid(
  rawPath: string,
  projectRoot?: FileSystemDirectoryHandle | null,
): Promise<ResolveScriptMetaResult> {
  const trimmed = rawPath.trim()
  if (!trimmed) {
    return { ok: false, scriptPath: '', error: '脚本路径不能为空' }
  }

  const scriptPath = normalizeScriptPath(trimmed)
  const baseName = scriptPath.split('/').pop() || ''
  if (!baseName || baseName.includes('.') === false) {
    return { ok: false, scriptPath, error: '请指定脚本文件，不能是文件夹' }
  }
  if (!isScriptFileName(baseName)) {
    return {
      ok: false,
      scriptPath,
      error: '只能选择脚本文件（.ts / .js）',
    }
  }

  const metaRel = metaPathForScript(scriptPath)
  let metaText: string | null = null

  if (isAbsoluteFsPath(scriptPath)) {
    metaText = await readLocalFsText(metaPathForScript(scriptPath))
    if (metaText == null) {
      // 再确认脚本本身是否存在，便于区分「无脚本」与「无 meta」
      const scriptText = await readLocalFsText(scriptPath)
      if (scriptText == null) {
        return { ok: false, scriptPath, error: `找不到脚本文件：${scriptPath}` }
      }
      return {
        ok: false,
        scriptPath,
        error: `路径下没有对应的 .meta 文件：${metaRel}`,
      }
    }
  } else if (projectRoot) {
    // 相对路径：先试项目根；若带 assets/ 前缀也直接试
    const candidates = [scriptPath]
    if (scriptPath.startsWith('assets/')) {
      candidates.push(scriptPath)
    }
    let foundScript = false
    for (const cand of candidates) {
      const scriptHandle = await getFileHandleByPath(projectRoot, cand)
      if (scriptHandle) {
        foundScript = true
        const metaHandle = await getFileHandleByPath(projectRoot, metaPathForScript(cand))
        if (metaHandle) {
          metaText = await readTextFile(metaHandle)
          break
        }
      }
      // 可能是目录误当作路径
      const asDir = await getDirectoryHandleByPath(projectRoot, cand)
      if (asDir) {
        return { ok: false, scriptPath, error: '请指定脚本文件，不能是文件夹' }
      }
    }
    if (!metaText) {
      return {
        ok: false,
        scriptPath,
        error: foundScript
          ? `路径下没有对应的 .meta 文件：${metaRel}`
          : `找不到脚本或 .meta：${scriptPath}`,
      }
    }
  } else {
    // 无项目句柄时，仍尝试本机绝对路径 / 开发态读取（db:// 转成的相对路径无法读）
    if (isAbsoluteFsPath(trimmed)) {
      metaText = await readLocalFsText(metaPathForScript(trimmed))
    }
    if (!metaText) {
      return {
        ok: false,
        scriptPath,
        error: '无法读取 .meta（请挂载项目，或拖入/输入本机绝对路径）',
      }
    }
  }

  const uuid = parseUuidFromMetaText(metaText)
  if (!uuid) {
    return { ok: false, scriptPath, error: `.meta 中缺少合法 uuid：${metaRel}` }
  }
  return { ok: true, scriptPath: trimmed, uuid }
}

/** 从拖放事件解析脚本路径（拒绝文件夹） */
export async function scriptPathFromDrop(e: DragEvent): Promise<ResolveScriptMetaResult> {
  const items = e.dataTransfer?.items
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      if (item.kind !== 'file') continue

      // File System Access：可区分文件/目录
      const anyItem = item as DataTransferItem & {
        getAsFileSystemHandle?: () => Promise<FileSystemHandle>
      }
      if (typeof anyItem.getAsFileSystemHandle === 'function') {
        try {
          const handle = await anyItem.getAsFileSystemHandle()
          if (handle.kind === 'directory') {
            return { ok: false, scriptPath: '', error: '不能拖入文件夹，请拖入脚本文件' }
          }
          if (handle.kind === 'file') {
            const name = handle.name
            if (!isScriptFileName(name)) {
              return {
                ok: false,
                scriptPath: name,
                error: '只能拖入脚本文件（.ts / .js）',
              }
            }
            const file = await (handle as FileSystemFileHandle).getFile()
            const abs =
              typeof (file as File & { path?: string }).path === 'string'
                ? (file as File & { path?: string }).path!
                : ''
            // 无绝对路径时，仅有文件名不够读 meta
            if (abs) {
              return { ok: true, scriptPath: abs }
            }
            // 尝试 text/plain 是否带了路径
            const textPath = e.dataTransfer?.getData('text/plain')?.trim()
            if (textPath) {
              return { ok: true, scriptPath: textPath }
            }
            return {
              ok: false,
              scriptPath: name,
              error: '无法获取脚本绝对路径，请改用手动输入本机路径，或从资源管理器拖入带路径的条目',
            }
          }
        } catch {
          /* fall through */
        }
      }

      const file = item.getAsFile()
      if (file) {
        if (!isScriptFileName(file.name)) {
          return {
            ok: false,
            scriptPath: file.name,
            error: '只能拖入脚本文件（.ts / .js）',
          }
        }
        const abs =
          typeof (file as File & { path?: string }).path === 'string'
            ? (file as File & { path?: string }).path!
            : ''
        if (abs) return { ok: true, scriptPath: abs }
      }
    }
  }

  const textPath = e.dataTransfer?.getData('text/plain')?.trim()
  if (textPath) {
    // 纯路径拖入：若以 / 结尾或无扩展名，视为文件夹
    if (textPath.endsWith('/') || textPath.endsWith('\\')) {
      return { ok: false, scriptPath: textPath, error: '不能拖入文件夹，请拖入脚本文件' }
    }
    const name = textPath.split(/[/\\]/).pop() || ''
    if (!isScriptFileName(name)) {
      return {
        ok: false,
        scriptPath: textPath,
        error: '只能拖入脚本文件（.ts / .js）',
      }
    }
    return { ok: true, scriptPath: textPath }
  }

  return { ok: false, scriptPath: '', error: '未检测到可识别的脚本文件' }
}

export function toastScriptMetaError(error: string) {
  ElMessage.warning(error)
}
