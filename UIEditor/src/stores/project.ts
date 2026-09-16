import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { AssetEntry, ComponentDefs, FileEntry } from '../types'
import {
  buildFileTree,
  collectImages,
  getDirectoryHandleByPath,
  getFileHandleByPath,
  moveEntryByPath,
  readTextFile,
  remapMovedPath,
  removeEntryByPath,
  topLevelEntryPaths,
  writeBinaryFile,
  writeTextFile,
} from '../utils/fs'
import {
  DEFAULT_COMPONENTS_JSON,
  createDefaultUIData,
  parseComponentDefs,
  remapSpriteFramePaths,
  serializeForDisk,
} from '../utils/node'
import { parsePsdFile, sanitizeFsName } from '../utils/psd'
import type { OnExportProgress } from '../utils/exportProgress'
import { yieldToUi } from '../utils/exportProgress'

/** 项目级状态：目录句柄、文件树、组件库定义、图片资产 */
export const useProjectStore = defineStore('project', () => {
  const dirHandle = shallowRef<FileSystemDirectoryHandle | null>(null)
  const projectName = ref('')
  const fileTree = ref<FileEntry[]>([])
  const componentDefs = ref<ComponentDefs>(parseComponentDefs(DEFAULT_COMPONENTS_JSON))
  const componentDefsText = ref(DEFAULT_COMPONENTS_JSON)
  const assets = ref<AssetEntry[]>([])
  /** 资产变更版本号，画布用它来失效纹理缓存 */
  const assetVersion = ref(0)
  /** 资源管理器文件夹过滤：空字符串表示显示全部；否则只显示该目录（含子目录）内图片 */
  const assetFolderFilter = ref('')

  const filteredAssets = computed(() => {
    const folder = assetFolderFilter.value
    if (!folder) return assets.value
    const prefix = folder.endsWith('/') ? folder : `${folder}/`
    return assets.value.filter((a) => a.path.startsWith(prefix) || a.path === folder)
  })

  let assetSignature = ''

  async function mountDirectory(handle: FileSystemDirectoryHandle) {
    dirHandle.value = handle
    projectName.value = handle.name
    assetFolderFilter.value = ''
    await Promise.all([refreshFileTree(), loadComponentDefs(), refreshAssets()])
  }

  function setAssetFolderFilter(path: string) {
    assetFolderFilter.value = path
  }

  function clearAssetFolderFilter() {
    assetFolderFilter.value = ''
  }

  /** 文件夹是否为空（忽略 .DS_Store 等隐藏文件） */
  async function isDirectoryEmpty(dir: FileSystemDirectoryHandle): Promise<boolean> {
    for await (const handle of dir.values()) {
      if (!handle.name.startsWith('.')) return false
    }
    return true
  }

  /** 初始化项目目录结构：components.json、assets/、基础 main.json，返回 main.json 句柄 */
  async function initProjectStructure(dir: FileSystemDirectoryHandle): Promise<FileSystemFileHandle> {
    const componentsHandle = await dir.getFileHandle('components.json', { create: true })
    const existing = await (await componentsHandle.getFile()).text()
    if (!existing.trim()) {
      await writeTextFile(componentsHandle, DEFAULT_COMPONENTS_JSON)
    }
    await dir.getDirectoryHandle('assets', { create: true })

    let mainHandle: FileSystemFileHandle
    try {
      mainHandle = await dir.getFileHandle('main.json')
    } catch {
      mainHandle = await dir.getFileHandle('main.json', { create: true })
      await writeTextFile(mainHandle, serializeForDisk(createDefaultUIData()))
    }
    return mainHandle
  }

  /**
   * 导入项目：授权选择本地文件夹。
   * 若文件夹为空，自动初始化目录结构并返回基础 UI 文件供打开；否则返回 null。
   */
  async function importProject(): Promise<{ handle: FileSystemFileHandle; path: string } | null> {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'ui-editor-project' })
    let mainHandle: FileSystemFileHandle | null = null
    if (await isDirectoryEmpty(dir)) {
      mainHandle = await initProjectStructure(dir)
    }
    await mountDirectory(dir)
    return mainHandle ? { handle: mainHandle, path: 'main.json' } : null
  }

  /** 新建项目：选择目标文件夹并初始化目录结构，返回默认 UI 文件句柄 */
  async function newProject(): Promise<{ handle: FileSystemFileHandle; path: string } | null> {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'ui-editor-project' })
    const mainHandle = await initProjectStructure(dir)
    await mountDirectory(dir)
    return { handle: mainHandle, path: 'main.json' }
  }

  async function refreshFileTree() {
    if (!dirHandle.value) return
    fileTree.value = await buildFileTree(dirHandle.value)
  }

  /**
   * Sprite.sizeMode / type：始终与 config 默认对齐（options + default），
   * 避免项目内旧 components.json 仍写 default:CUSTOM 导致新建组件不是 TRIMMED。
   */
  function normalizeSpriteEnumDefs(defs: ComponentDefs): ComponentDefs {
    const defaults = parseComponentDefs(DEFAULT_COMPONENTS_JSON).SpriteComponent?.properties
    const sprite = defs.SpriteComponent
    if (!sprite?.properties || !defaults) return defs
    for (const key of ['sizeMode', 'type'] as const) {
      const want = defaults[key]
      if (!want) continue
      sprite.properties[key] = {
        ...want,
        options: want.options ? want.options.map((o) => ({ ...o })) : [],
      }
    }
    return defs
  }

  /** 项目旧 components.json 缺内置组件/属性时补齐；并去掉已废弃字段 */
  function mergeMissingBuiltinDefs(defs: ComponentDefs): ComponentDefs {
    const builtins = parseComponentDefs(DEFAULT_COMPONENTS_JSON)
    const merged: ComponentDefs = { ...defs }
    for (const [name, def] of Object.entries(builtins)) {
      if (!merged[name]) {
        merged[name] = def
        continue
      }
      const cur = merged[name]!
      const curProps: Record<string, (typeof def.properties)[string]> = {
        ...(cur.properties ?? {}),
      }
      let changed = false
      for (const [pk, pv] of Object.entries(def.properties ?? {})) {
        if (!curProps[pk]) {
          curProps[pk] = pv
          changed = true
        }
      }
      if (name === 'ButtonComponent') {
        const target = curProps.target
        if (target && (target.type !== 'node' || target.default !== '.')) {
          curProps.target = { ...target, type: 'node', default: '.' }
          changed = true
        }
      }
      if (name === 'SimpleListComponent') {
        for (const drop of ['itemPrefab', 'itemNode', 'isSetUUID'] as const) {
          if (drop in curProps) {
            delete curProps[drop]
            changed = true
          }
        }
        const vertical = curProps.Vertical
        if (vertical && vertical.default !== true) {
          curProps.Vertical = { ...vertical, default: true }
          changed = true
        }
      }
      if (changed) {
        merged[name] = { ...cur, properties: curProps }
      }
    }
    return merged
  }

  async function loadComponentDefs() {
    if (!dirHandle.value) return
    try {
      const handle = await dirHandle.value.getFileHandle('components.json')
      const text = await readTextFile(handle)
      const parsed = mergeMissingBuiltinDefs(normalizeSpriteEnumDefs(parseComponentDefs(text)))
      componentDefs.value = parsed
      componentDefsText.value = JSON.stringify(parsed, null, 2) + '\n'
    } catch {
      // 项目内没有 components.json 时沿用内置默认组件库
      componentDefs.value = parseComponentDefs(DEFAULT_COMPONENTS_JSON)
      componentDefsText.value = DEFAULT_COMPONENTS_JSON
    }
  }

  /** 校验并保存组件库定义，写回本地 components.json */
  async function saveComponentDefs(text: string) {
    const parsed = parseComponentDefs(text)
    if (dirHandle.value) {
      const handle = await dirHandle.value.getFileHandle('components.json', { create: true })
      await writeTextFile(handle, text)
    }
    componentDefs.value = parsed
    componentDefsText.value = text
    await refreshFileTree()
  }

  /** 扫描项目内图片；内容签名一致时跳过，避免焦点轮询时反复重建缩略图 */
  async function refreshAssets(force = false) {
    if (!dirHandle.value) return
    const images = await collectImages(dirHandle.value)
    const signature = images.map((i) => `${i.path}|${i.file.size}|${i.file.lastModified}`).join('\n')
    if (!force && signature === assetSignature) return
    assetSignature = signature

    assets.value.forEach((a) => URL.revokeObjectURL(a.url))
    assets.value = images.map((i) => ({ name: i.name, path: i.path, url: URL.createObjectURL(i.file) }))
    assetVersion.value += 1
  }

  /** 按项目相对路径读取文件（画布加载纹理用） */
  async function getFileByPath(path: string): Promise<File | null> {
    if (!dirHandle.value) return null
    const handle = await getFileHandleByPath(dirHandle.value, path)
    if (!handle) return null
    return handle.getFile()
  }

  /** 在项目根目录创建文本文件 */
  async function createProjectFile(path: string, content: string): Promise<FileSystemFileHandle> {
    if (!dirHandle.value) throw new Error('尚未打开项目')
    const handle = await getFileHandleByPath(dirHandle.value, path, true)
    if (!handle) throw new Error(`无法创建文件 ${path}`)
    await writeTextFile(handle, content)
    await refreshFileTree()
    return handle
  }

  /**
   * 新建文件夹。
   * @param parentPath 父目录项目相对路径，空字符串表示项目根
   * @param name 文件夹名
   */
  async function createFolder(parentPath: string, name: string): Promise<string> {
    if (!dirHandle.value) throw new Error('尚未打开项目')
    const safe = sanitizeFsName(name)
    const fullPath = parentPath ? `${parentPath}/${safe}` : safe
    const handle = await getDirectoryHandleByPath(dirHandle.value, fullPath, true)
    if (!handle) throw new Error(`无法创建文件夹 ${fullPath}`)
    await refreshFileTree()
    return fullPath
  }

  /** 删除文件或文件夹（递归）；若删的是当前资源过滤目录则清空过滤 */
  async function deleteEntry(path: string): Promise<void> {
    if (!dirHandle.value) throw new Error('尚未打开项目')
    await removeEntryByPath(dirHandle.value, path)
    if (
      assetFolderFilter.value === path ||
      assetFolderFilter.value.startsWith(`${path}/`)
    ) {
      assetFolderFilter.value = ''
    }
    await Promise.all([refreshFileTree(), refreshAssets(true)])
  }

  /**
   * 把若干文件/文件夹移到目标目录（磁盘复制后删源）。
   * 返回 { from, to }；名称冲突或移入自身/子孙则抛错。
   */
  async function moveEntries(
    srcPaths: string[],
    destDirPath: string,
  ): Promise<{ from: string; to: string }[]> {
    if (!dirHandle.value) throw new Error('尚未打开项目')
    const top = topLevelEntryPaths(srcPaths)
    const moved: { from: string; to: string }[] = []
    for (const src of top) {
      if (src === destDirPath || (destDirPath && destDirPath.startsWith(`${src}/`))) {
        throw new Error(`不能将「${src}」移动到自身或子目录`)
      }
      const name = src.split('/').pop()
      if (!name) continue
      const dest = destDirPath ? `${destDirPath}/${name}` : name
      if (dest === src) continue
      await moveEntryByPath(dirHandle.value, src, dest)
      moved.push({ from: src, to: dest })
    }
    if (assetFolderFilter.value) {
      let next = assetFolderFilter.value
      for (const { from, to } of moved) next = remapMovedPath(next, from, to)
      assetFolderFilter.value = next
    }
    await Promise.all([refreshFileTree(), refreshAssets(true)])
    return moved
  }

  function collectUiJsonPaths(entries: FileEntry[]): string[] {
    const out: string[] = []
    const walk = (list: FileEntry[]) => {
      for (const e of list) {
        if (e.kind === 'directory') {
          walk(e.children ?? [])
          continue
        }
        if (!e.name.toLowerCase().endsWith('.json')) continue
        if (e.name === 'components.json') continue
        out.push(e.path)
      }
    }
    walk(entries)
    return out
  }

  /**
   * 资源移动后改写其它 UI JSON 里的 Sprite.framePath。
   * 跳过当前已打开文件（由编辑器改内存树）；返回改写的文件数。
   */
  async function rewriteSpriteFramePathsInUiFiles(
    moved: { from: string; to: string }[],
    skipPath: string,
  ): Promise<number> {
    if (!dirHandle.value || !moved.length) return 0
    let files = 0
    for (const rel of collectUiJsonPaths(fileTree.value)) {
      if (skipPath && rel === skipPath) continue
      try {
        const handle = await getFileHandleByPath(dirHandle.value, rel)
        if (!handle) continue
        const raw: unknown = JSON.parse(await readTextFile(handle))
        if (!remapSpriteFramePaths(raw, moved)) continue
        await writeTextFile(handle, JSON.stringify(raw, null, 2))
        files += 1
      } catch (err) {
        console.warn(`同步 framePath 失败: ${rel}`, err)
      }
    }
    return files
  }

  /**
   * 导入 PSD：解析图层为 PNG 写入 {A}/UI/，并生成 {A}/{A}.json UI 界面。
   * 返回创建的 JSON 文件句柄与路径，供编辑器直接打开。
   */
  async function importPsd(
    file: File,
    options?: {
      onProgress?: OnExportProgress
      /** Root 设计分辨率；默认当前编辑器分辨率 / 1366×768 */
      rootWidth?: number
      rootHeight?: number
    },
  ): Promise<{
    handle: FileSystemFileHandle
    path: string
    layerCount: number
    uniqueImageCount: number
    documentWidth: number
    documentHeight: number
    rootWidth: number
    rootHeight: number
  }> {
    if (!dirHandle.value) throw new Error('尚未打开项目')
    const onProgress = options?.onProgress
    const parsed = await parsePsdFile(file, {
      rootWidth: options?.rootWidth,
      rootHeight: options?.rootHeight,
      onProgress,
      componentDefs: componentDefs.value,
    })

    onProgress?.({
      engine: 'psd',
      phase: 'write-images',
      message: `正在创建目录 ${parsed.folderPath}/UI …`,
      current: 0,
      total: Math.max(1, parsed.images.length + 1),
    })
    await getDirectoryHandleByPath(dirHandle.value, parsed.uiFolderPath, true)

    const writeTotal = Math.max(1, parsed.images.length + 1)
    for (let i = 0; i < parsed.images.length; i++) {
      const img = parsed.images[i]!
      onProgress?.({
        engine: 'psd',
        phase: 'write-images',
        message: `正在写入图片（${i + 1}/${parsed.images.length}）${img.fileName}`,
        current: i + 1,
        total: writeTotal,
      })
      const fh = await getFileHandleByPath(dirHandle.value, img.relativePath, true)
      if (!fh) throw new Error(`无法写入 ${img.relativePath}`)
      await writeBinaryFile(fh, img.bytes)
      await yieldToUi()
    }

    onProgress?.({
      engine: 'psd',
      phase: 'write-images',
      message: `正在写入界面 ${parsed.jsonPath}`,
      current: writeTotal,
      total: writeTotal,
    })
    const jsonHandle = await getFileHandleByPath(dirHandle.value, parsed.jsonPath, true)
    if (!jsonHandle) throw new Error(`无法写入 ${parsed.jsonPath}`)
    await writeTextFile(jsonHandle, parsed.jsonContent)

    await Promise.all([refreshFileTree(), refreshAssets(true)])
    return {
      handle: jsonHandle,
      path: parsed.jsonPath,
      layerCount: parsed.layerCount,
      uniqueImageCount: parsed.uniqueImageCount,
      documentWidth: parsed.documentWidth,
      documentHeight: parsed.documentHeight,
      rootWidth: parsed.rootWidth,
      rootHeight: parsed.rootHeight,
    }
  }

  return {
    dirHandle,
    projectName,
    fileTree,
    componentDefs,
    componentDefsText,
    assets,
    filteredAssets,
    assetFolderFilter,
    assetVersion,
    importProject,
    newProject,
    refreshFileTree,
    loadComponentDefs,
    saveComponentDefs,
    refreshAssets,
    getFileByPath,
    createProjectFile,
    createFolder,
    deleteEntry,
    moveEntries,
    rewriteSpriteFramePathsInUiFiles,
    importPsd,
    setAssetFolderFilter,
    clearAssetFolderFilter,
  }
})
