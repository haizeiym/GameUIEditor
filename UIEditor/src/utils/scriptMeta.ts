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

export function isMarkdownFileName(name: string): boolean {
  return name.toLowerCase().replace(/\\/g, '/').endsWith('.md')
}

function nativeFilePath(file: File | null | undefined): string {
  if (!file) return ''
  const p = (file as File & { path?: string }).path
  return typeof p === 'string' ? p.trim() : ''
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

export function isAbsoluteFsPath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)
}

export function droppedFilePaths(e: DragEvent): string[] {
  return collectDropPathCandidates(e.dataTransfer)
}

/** file:///Users/x/a.ts → /Users/x/a.ts；Windows file:///C:/x → C:/x */
export function fileUrlToFsPath(url: string): string | null {
  const raw = url.trim()
  if (!raw.toLowerCase().startsWith('file:')) return null
  // macOS 书签 file:///.file/id=… 不是可读路径
  if (/^file:\/\/\/\.file\//i.test(raw)) return null
  try {
    // 保留 decode，处理空格 %20 等
    let path = decodeURIComponent(raw.replace(/^file:\/\//i, ''))
    path = path.replace(/^localhost/i, '')
    // Chrome Windows 常给出 /C:/Users/...
    if (/^\/[a-zA-Z]:[\\/]/.test(path)) path = path.slice(1)
    path = path.replace(/\\/g, '/')
    return path || null
  } catch {
    return null
  }
}

/** 从任意拖放文本里抠出可用的 .md 文件系统路径 */
export function extractMarkdownFsPath(text: string): string | null {
  const raw = text.trim()
  if (!raw) return null
  const fromUrl = fileUrlToFsPath(raw)
  if (fromUrl && isUsableMarkdownPath(fromUrl)) return fromUrl
  const normalized = raw.replace(/\\/g, '/')
  if (isUsableMarkdownPath(normalized)) return normalized
  const urlMatch = raw.match(/file:\/\/[^\s"'<>]+/i)
  if (urlMatch) {
    const p = fileUrlToFsPath(urlMatch[0])
    if (p && isUsableMarkdownPath(p)) return p
  }
  const posix = raw.match(/(^|[\s"'=(])(\/[^\s"'<>]+\.md)/i)
  if (posix?.[2] && isUsableMarkdownPath(posix[2])) return posix[2]
  const win = raw.match(/([a-zA-Z]:[\\/][^\s"'<>]+\.md)/i)
  if (win?.[1]) return win[1].replace(/\\/g, '/')
  return null
}

function isUsableMarkdownPath(p: string): boolean {
  const n = p.trim().replace(/\\/g, '/')
  if (!isMarkdownFileName(n)) return false
  return n.includes('/') || isAbsoluteFsPath(n)
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

  const ingestText = (text: string) => {
    if (!text) return
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const md = extractMarkdownFsPath(trimmed)
      if (md) push(md)
      else {
        const fsPath = fileUrlToFsPath(trimmed)
        push(fsPath || trimmed)
      }
    }
  }

  // 1) Finder / 资源管理器拖入：text/uri-list → file:///绝对路径
  ingestText(dt.getData('text/uri-list') || '')

  // 2) text/plain：可能是绝对路径、项目相对路径、或 file://
  ingestText(dt.getData('text/plain') || '')

  // 3) 其它 MIME（text/html、public.file-url 等）里可能夹着路径
  try {
    for (const type of Array.from(dt.types || [])) {
      if (type === 'Files' || type === 'text/uri-list' || type === 'text/plain') continue
      ingestText(dt.getData(type) || '')
    }
  } catch {
    /* 部分 type 的 getData 会抛 */
  }

  // 4) Chromium / Electron：File.path
  if (dt.files) {
    for (let i = 0; i < dt.files.length; i++) {
      const native = nativeFilePath(dt.files[i])
      if (native) push(native)
    }
  }

  return out
}

export type MarkdownDropResult =
  | { ok: true; path: string; text?: string }
  | { ok: false; error: string; fileName?: string; text?: string }

async function readDroppedMarkdownFile(dt: DataTransfer | null): Promise<File | null> {
  if (!dt) return null
  const items = dt.items
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
            throw new Error('不能拖入文件夹，请拖入 .md 文件')
          }
          if (handle.kind === 'file' && isMarkdownFileName(handle.name)) {
            return await (handle as FileSystemFileHandle).getFile()
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('不能拖入文件夹')) throw err
        }
      }
      const file = item.getAsFile()
      if (file && isMarkdownFileName(file.name)) return file
    }
  }
  if (dt.files) {
    for (let i = 0; i < dt.files.length; i++) {
      const file = dt.files[i]
      if (file && isMarkdownFileName(file.name)) return file
    }
  }
  return null
}

/** 从拖放解析 .md 路径，并读出正文（打包环境导出必须靠这次缓存） */
export async function markdownPathFromDrop(e: DragEvent): Promise<MarkdownDropResult> {
  const dt = e.dataTransfer
  let mdFile: File | null = null
  try {
    mdFile = await readDroppedMarkdownFile(dt)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '不能拖入文件夹，请拖入 .md 文件' }
  }

  let text: string | undefined
  if (mdFile) {
    try {
      text = await mdFile.text()
    } catch (err) {
      console.warn('[scriptMeta] 读取拖入的 .md 失败', err)
    }
  }

  let path: string | null = null
  for (const cand of collectDropPathCandidates(dt)) {
    const usable =
      extractMarkdownFsPath(cand) || (isUsableMarkdownPath(cand) ? cand.replace(/\\/g, '/') : null)
    if (usable) {
      path = usable
      break
    }
  }
  if (!path && mdFile) {
    const native = nativeFilePath(mdFile).replace(/\\/g, '/')
    if (native && isUsableMarkdownPath(native)) path = native
    else if (native && isMarkdownFileName(mdFile.name)) path = native
  }

  if (path) return { ok: true, path, text }
  if (mdFile) {
    return {
      ok: false,
      fileName: mdFile.name,
      text,
      error: `已检测到「${mdFile.name}」，但浏览器未暴露绝对路径。请粘贴本机路径（如 /Users/.../${mdFile.name}）`,
    }
  }
  return {
    ok: false,
    error: '未检测到 .md 路径。请拖入文件，或粘贴绝对路径（如 /Users/.../cocosPrefab.md）',
  }
}

/** 打包环境无法按绝对路径读盘时，让用户再选一次 .md */
export async function pickLocalMarkdownText(preferredName?: string): Promise<string | null> {
  if (typeof window.showOpenFilePicker !== 'function') return null
  const hint = preferredName ? `请选择模板文件「${preferredName}」` : '请选择 .md 模板文件'
  ElMessage.info(hint)
  try {
    const [handle] = await window.showOpenFilePicker({
      id: 'uieditor-template-md',
      multiple: false,
      excludeAcceptAllOption: false,
      types: [
        {
          description: 'Markdown 模板 (.md)',
          accept: {
            'text/markdown': ['.md'],
            'text/plain': ['.md'],
          },
        },
      ],
    } as Parameters<Window['showOpenFilePicker']>[0])
    if (!handle) return null
    const file = await handle.getFile()
    return await file.text()
  } catch {
    return null
  }
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
export async function readLocalFsText(absPath: string): Promise<string | null> {
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
