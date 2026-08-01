import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { AssetEntry, ComponentDefs, FileEntry } from '../types'
import { buildFileTree, collectImages, getFileHandleByPath, readTextFile, writeTextFile } from '../utils/fs'
import { DEFAULT_COMPONENTS_JSON, createDefaultUIData, parseComponentDefs, serializeForDisk } from '../utils/node'

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

  async function loadComponentDefs() {
    if (!dirHandle.value) return
    try {
      const handle = await dirHandle.value.getFileHandle('components.json')
      const text = await readTextFile(handle)
      componentDefs.value = parseComponentDefs(text)
      componentDefsText.value = text
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
    setAssetFolderFilter,
    clearAssetFolderFilter,
  }
})
