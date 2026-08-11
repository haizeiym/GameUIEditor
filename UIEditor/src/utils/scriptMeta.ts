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

/** file:///Users/x/a.ts → /Users/x/a.ts；Windows file:///C:/x → C:/x */
export function fileUrlToFsPath(url: string): string | null {
  const raw = url.trim()
  if (!raw.toLowerCase().startsWith('file:')) return null
  try {
    // 保留 decode，处理空格 %20 等
    let path = decodeURIComponent(raw.replace(/^file:\/\//i, ''))
    // Chrome Windows 常给出 /C:/Users/...
    if (/^\/[a-zA-Z]:[\\/]/.test(path)) path = path.slice(1)
    path = path.replace(/\\/g, '/')
    return path || null
  } catch {
    return null
  }
}

/** 从 DataTransfer 收集可能的绝对/相对路径（优先 file://） */
function collectDropPathCandidates(dt: DataTransfer | null): string[] {
  if (!dt) return []
  const out: string[] = []
  const seen = new Set<string>()
  const push = (p: string) => {
    const t = p.trim()
    if (!t || seen.has(t)) return
    seen.add(t)
    out.push(t)
  }

  // 1) Finder / 资源管理器拖入：text/uri-list → file:///绝对路径
  const uriList = dt.getData('text/uri-list') || ''
  for (const line of uriList.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const fsPath = fileUrlToFsPath(trimmed)
    if (fsPath) push(fsPath)
    else push(trimmed)
  }

  // 2) text/plain：可能是绝对路径、项目相对路径、或 file://
  const plain = dt.getData('text/plain')?.trim() || ''
  if (plain) {
    const asFile = fileUrlToFsPath(plain)
    push(asFile || plain)
  }

  return out
}

/**
 * 浏览器无法暴露本机绝对路径时：用文件选择器选同目录 `.meta`（可选文件，不是文件夹）。
 * `startIn` 指向刚拖入的脚本，系统文件框会打开到同一目录。
 */
async function readMetaViaOpenFilePicker(
  scriptHandle: FileSystemFileHandle,
  scriptFileName: string,
): Promise<{ metaText: string; scriptPath: string } | null> {
  if (typeof window.showOpenFilePicker !== 'function') return null
  const metaName = `${scriptFileName}.meta`
  ElMessage.info(`请选择同目录下的「${metaName}」文件（不要选文件夹）`)
  try {
    const [metaHandle] = await window.showOpenFilePicker({
      id: 'uieditor-cocos-script-meta',
      multiple: false,
      // 打开到拖入脚本所在目录，方便点选 xxx.ts.meta
      startIn: scriptHandle,
      excludeAcceptAllOption: false,
      types: [
        {
          description: 'Cocos 脚本 Meta (.meta)',
          accept: {
            'application/json': ['.meta'],
            'text/plain': ['.meta'],
          },
        },
      ],
    } as Parameters<Window['showOpenFilePicker']>[0])
    if (!metaHandle) return null
    // 若用户误选了别的文件，仍尝试按内容解析；名称不对则提示
    if (metaHandle.name.toLowerCase() !== metaName.toLowerCase()) {
      ElMessage.warning(`建议选择「${metaName}」，当前为「${metaHandle.name}」，将尝试解析…`)
    }
    const metaText = await readTextFile(metaHandle)
    return { metaText, scriptPath: scriptFileName }
  } catch {
    // 用户取消
    return null
  }
}

/** 直接读取拖入的 .meta 文件内容 */
async function readDroppedMetaFile(
  handle: FileSystemFileHandle,
): Promise<ResolveScriptMetaResult> {
  const name = handle.name
  if (!name.toLowerCase().endsWith('.meta')) {
    return { ok: false, scriptPath: name, error: '请拖入 .ts 脚本或对应的 .meta 文件' }
  }
  const metaText = await readTextFile(handle)
  const uuid = parseUuidFromMetaText(metaText)
  if (!uuid) {
    return { ok: false, scriptPath: name, error: `.meta 中缺少合法 uuid：${name}` }
  }
  // SimpleList.ts.meta → SimpleList.ts
  const scriptPath = name.replace(/\.meta$/i, '')
  return { ok: true, scriptPath, uuid }
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

/** 从拖放事件解析脚本路径（拒绝文件夹；支持 file:// 绝对路径） */
export async function scriptPathFromDrop(e: DragEvent): Promise<ResolveScriptMetaResult> {
  const dt = e.dataTransfer
  const pathCandidates = collectDropPathCandidates(dt)

  // 优先：已带绝对路径 / 合法脚本路径的候选（含 Finder file://）
  for (const cand of pathCandidates) {
    if (cand.endsWith('/') || cand.endsWith('\\')) {
      return { ok: false, scriptPath: cand, error: '不能拖入文件夹，请拖入脚本文件' }
    }
    const name = cand.split(/[/\\]/).pop() || ''
    if (!isScriptFileName(name)) continue
    // 绝对路径或相对路径都先交给 resolveScriptMetaUuid 校验
    return { ok: true, scriptPath: cand }
  }

  const items = dt?.items
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      if (item.kind !== 'file') continue

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
            // 直接拖入 .meta：读 UUID，脚本路径取去掉 .meta 的文件名
            if (name.toLowerCase().endsWith('.meta')) {
              return await readDroppedMetaFile(handle as FileSystemFileHandle)
            }
            if (!isScriptFileName(name)) {
              return {
                ok: false,
                scriptPath: name,
                error: '只能拖入脚本文件（.ts / .js）或对应的 .meta',
              }
            }
            const file = await (handle as FileSystemFileHandle).getFile()
            const electronPath =
              typeof (file as File & { path?: string }).path === 'string'
                ? (file as File & { path?: string }).path!.trim()
                : ''
            if (electronPath) {
              return { ok: true, scriptPath: electronPath }
            }

            // Mac Chrome 等：无绝对路径 → 弹出「选文件」对话框选同目录 .meta（不是选文件夹）
            const picked = await readMetaViaOpenFilePicker(
              handle as FileSystemFileHandle,
              name,
            )
            if (picked) {
              const uuid = parseUuidFromMetaText(picked.metaText)
              if (!uuid) {
                return {
                  ok: false,
                  scriptPath: picked.scriptPath,
                  error: `.meta 中缺少合法 uuid：${name}.meta`,
                }
              }
              return { ok: true, scriptPath: picked.scriptPath, uuid }
            }
            return {
              ok: false,
              scriptPath: name,
              error:
                '已取消。也可直接拖入「脚本.ts.meta」，或手动粘贴绝对路径（如 /Users/.../SimpleList.ts）',
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
        const electronPath =
          typeof (file as File & { path?: string }).path === 'string'
            ? (file as File & { path?: string }).path!.trim()
            : ''
        if (electronPath) return { ok: true, scriptPath: electronPath }
      }
    }
  }

  // 仅有非脚本候选时给出明确提示
  if (pathCandidates.length) {
    return {
      ok: false,
      scriptPath: pathCandidates[0]!,
      error: '只能拖入脚本文件（.ts / .js）',
    }
  }

  return { ok: false, scriptPath: '', error: '未检测到可识别的脚本文件' }
}

export function toastScriptMetaError(error: string) {
  ElMessage.warning(error)
}
