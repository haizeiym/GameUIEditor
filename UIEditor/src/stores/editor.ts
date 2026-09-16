import { ElMessage } from 'element-plus'
import { defineStore } from 'pinia'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import type { Orientation, UINode } from '../types'
import { exportCocosPrefab, pathExists } from '../utils/cocosPrefab'
import type { OnExportProgress } from '../utils/exportProgress'
import { readTextFile, removeEntryByPath, writeBinaryFile, writeTextFile } from '../utils/fs'
import { writePsdTemplateBytes } from '../utils/psdExport'
import {
  latestRecentHandle,
  rememberRecentIo,
} from '../utils/recentIoPaths'
import {
  canAddComponent,
  cloneWithNewIds,
  createNode,
  detachChild,
  findNodeById,
  findParentById,
  isStrictDescendant,
  mountComponentOnNode,
  normalizeUIData,
  remapSpriteFramePaths,
  serializeForDisk,
  topLevelSelectedIds,
} from '../utils/node'
import { sanitizeFsName } from '../utils/psd'
import { toExportBaseName } from '../utils/imageFileName'
import { hasScriptBindProps, latestScriptBind } from '../utils/recentScriptBinds'
import { latestToFile } from '../utils/recentToFile'
import {
  latestTemplateAlias,
  latestTemplatePath,
  latestTemplateType,
} from '../utils/recentTemplateTypes'
import { isAbsoluteFsPath, pickLocalMarkdownText, readLocalFsText } from '../utils/scriptMeta'
import { getCachedTemplateMd, rememberTemplateMd } from '../utils/templateMdCache'
import { useProjectStore } from './project'

const MAX_HISTORY = 50
const SAVE_DEBOUNCE_MS = 300
const DEFAULT_WIDTH = 1366
const DEFAULT_HEIGHT = 768

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

/**
 * 编辑器核心状态：currentUIData 是唯一响应式数据源。
 * 画布 / 节点树 / 属性栏的修改都直接改它 → 视图立即重绘；
 * 写盘经 300ms 防抖；历史栈在操作提交点（blur / 拖拽结束等）通过 commit() 记录。
 */
export const useEditorStore = defineStore('editor', () => {
  const project = useProjectStore()

  const currentUIData = ref<UINode | null>(null)
  const currentFileHandle = shallowRef<FileSystemFileHandle | null>(null)
  const currentFilePath = ref('')
  const selectedId = ref<string | null>(null)
  /** 节点树多选（含当前 selectedId；不含已删节点） */
  const selectedIds = ref<string[]>([])
  const saveState = ref<SaveState>('idle')

  /** 设计分辨率（默认横屏 1366×768）；画布中心为坐标原点 (0,0) */
  const canvasWidth = ref(DEFAULT_WIDTH)
  const canvasHeight = ref(DEFAULT_HEIGHT)
  const orientation = ref<Orientation>('landscape')

  /** 撤销/重做栈存 JSON 快照（含 _id，保证撤销后选中态与树结构对得上） */
  const past = ref<string[]>([])
  const future = ref<string[]>([])
  /** 最近一次已提交状态的快照 */
  let lastCommitted = ''
  /** 加载/撤销恢复期间抑制自动写盘 watcher */
  let suppressWatch = false
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  const selectedNode = computed(() => findNodeById(currentUIData.value, selectedId.value))
  const rootId = computed(() => currentUIData.value?._id ?? null)
  const isRootSelected = computed(() => selectedId.value !== null && selectedId.value === rootId.value)
  const selectedCount = computed(() => selectedIds.value.length)
  const canUndo = computed(() => past.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)
  const resolutionLabel = computed(() => `${canvasWidth.value}×${canvasHeight.value}`)

  function pruneSelection() {
    const root = currentUIData.value
    if (!root) {
      selectedId.value = null
      selectedIds.value = []
      return
    }
    selectedIds.value = selectedIds.value.filter((id) => findNodeById(root, id))
    if (!findNodeById(root, selectedId.value)) {
      selectedId.value = selectedIds.value[0] ?? root._id
    }
    if (selectedId.value && !selectedIds.value.includes(selectedId.value)) {
      selectedIds.value = [selectedId.value]
    }
  }

  /** additive=true 为 Ctrl/⌘ 切换；Root 不进入多选集合 */
  function selectNode(id: string | null, additive = false) {
    const root = currentUIData.value
    if (!root || !id) {
      selectedId.value = root?._id ?? null
      selectedIds.value = selectedId.value ? [selectedId.value] : []
      return
    }
    if (!findNodeById(root, id)) return
    if (additive && id !== root._id) {
      const set = new Set(selectedIds.value.filter((x) => x !== root._id))
      if (set.has(id)) set.delete(id)
      else set.add(id)
      if (!set.size) {
        selectedId.value = id
        selectedIds.value = [id]
        return
      }
      selectedIds.value = [...set]
      selectedId.value = id
      return
    }
    selectedId.value = id
    selectedIds.value = [id]
  }

  function setSelectedIds(ids: string[]) {
    const root = currentUIData.value
    if (!root) {
      selectedIds.value = []
      return
    }
    const next = ids.filter((id) => id !== root._id && findNodeById(root, id))
    selectedIds.value = next
    if (selectedId.value && next.includes(selectedId.value)) return
    selectedId.value = next[next.length - 1] ?? root._id
    if (!next.length) selectedIds.value = selectedId.value ? [selectedId.value] : []
  }

  function reindexZ(n: UINode) {
    n.children.forEach((c, i) => {
      c.zIndex = i
      reindexZ(c)
    })
  }

  function syncOrientation(width: number, height: number) {
    orientation.value = width >= height ? 'landscape' : 'portrait'
  }

  /**
   * 用根节点宽高同步设计分辨率（打开文件时）。
   * Root 尺寸即设计分辨率；并强制 Root 锚在 (0,0)。
   */
  function syncResolutionFromRoot(root: UINode) {
    const w = Math.max(1, Math.round(root.width) || DEFAULT_WIDTH)
    const h = Math.max(1, Math.round(root.height) || DEFAULT_HEIGHT)
    root.width = w
    root.height = h
    root.x = 0
    root.y = 0
    canvasWidth.value = w
    canvasHeight.value = h
    syncOrientation(w, h)
  }

  /**
   * 将设计分辨率写回 Root（横竖屏切换 / 设置分辨率）。
   * Root 宽高始终等于当前设计分辨率，坐标固定 (0,0)。
   */
  function applyResolutionToRoot(width: number, height: number, pushHistory = true) {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    canvasWidth.value = w
    canvasHeight.value = h
    syncOrientation(w, h)

    const root = currentUIData.value
    if (!root) return
    if (root.width === w && root.height === h && root.x === 0 && root.y === 0) return
    root.width = w
    root.height = h
    root.x = 0
    root.y = 0
    if (pushHistory) commit()
  }

  function toggleOrientation() {
    applyResolutionToRoot(canvasHeight.value, canvasWidth.value, true)
  }

  function setResolution(width: number, height: number) {
    applyResolutionToRoot(width, height, true)
  }

  /** 确保当前 Root 与设计分辨率一致（加载后 / 异常漂移时纠偏） */
  function ensureRootMatchesResolution(pushHistory = false) {
    applyResolutionToRoot(canvasWidth.value, canvasHeight.value, pushHistory)
  }

  function snapshot(): string {
    return JSON.stringify(currentUIData.value)
  }

  // ---------- 写盘（防抖） ----------

  function scheduleSave() {
    if (!currentFileHandle.value || !currentUIData.value) return
    saveState.value = 'pending'
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void saveNow(), SAVE_DEBOUNCE_MS)
  }

  async function saveNow() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const handle = currentFileHandle.value
    if (!handle || !currentUIData.value) return
    saveState.value = 'saving'
    try {
      if (handle.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        await handle.requestPermission?.({ mode: 'readwrite' })
      }
      await writeTextFile(handle, serializeForDisk(currentUIData.value))
      saveState.value = 'saved'
    } catch (err) {
      console.error('写入文件失败', err)
      saveState.value = 'error'
    }
  }

  watch(
    currentUIData,
    () => {
      if (suppressWatch || !currentUIData.value) return
      scheduleSave()
    },
    { deep: true },
  )

  // ---------- 历史栈 ----------

  /** 在一次编辑操作完成时调用：把操作前的镜像压入撤销栈 */
  function commit() {
    if (!currentUIData.value) return
    const snap = snapshot()
    if (snap === lastCommitted) return
    past.value.push(lastCommitted)
    if (past.value.length > MAX_HISTORY) past.value.shift()
    future.value = []
    lastCommitted = snap
  }

  async function applySnapshot(snap: string) {
    suppressWatch = true
    currentUIData.value = JSON.parse(snap) as UINode
    pruneSelection()
    // 撤销/重做分辨率或横竖屏后，画布框与 Root 保持一致
    if (currentUIData.value) syncResolutionFromRoot(currentUIData.value)
    await nextTick()
    suppressWatch = false
    scheduleSave()
  }

  async function undo() {
    if (!past.value.length) return
    future.value.push(lastCommitted)
    const snap = past.value.pop()!
    lastCommitted = snap
    await applySnapshot(snap)
  }

  async function redo() {
    if (!future.value.length) return
    past.value.push(lastCommitted)
    const snap = future.value.pop()!
    lastCommitted = snap
    await applySnapshot(snap)
  }

  // ---------- 文件操作 ----------

  async function loadUIFile(handle: FileSystemFileHandle, path: string): Promise<boolean> {
    const text = await readTextFile(handle)
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return false
    }
    const data = normalizeUIData(raw)
    if (!data) return false

    if (saveTimer) clearTimeout(saveTimer)
    suppressWatch = true
    currentUIData.value = data
    currentFileHandle.value = handle
    currentFilePath.value = path
    selectedId.value = data._id
    selectedIds.value = [data._id]
    syncResolutionFromRoot(data)
    // Root 尺寸 = 设计分辨率（横竖屏均如此）
    ensureRootMatchesResolution(false)
    past.value = []
    future.value = []
    lastCommitted = snapshot()
    saveState.value = 'idle'
    await nextTick()
    suppressWatch = false
    return true
  }

  /** 导入外部 UI JSON 文件（保留句柄，可直接回写） */
  async function importUIFile(): Promise<boolean> {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'UI JSON', accept: { 'application/json': ['.json'] } }],
    })
    return loadUIFile(handle, handle.name)
  }

  /** 导出当前 UI 到用户选择的位置 */
  async function exportUIFile() {
    if (!currentUIData.value) return
    const suggested = currentFilePath.value.split('/').pop() || 'ui.json'
    const handle = await window.showSaveFilePicker({
      suggestedName: suggested,
      types: [{ description: 'UI JSON', accept: { 'application/json': ['.json'] } }],
    })
    await writeTextFile(handle, serializeForDisk(currentUIData.value))
  }

  /** 导出当前节点树为 Photoshop 模版 PSD（图层名 / 结构 / 显隐；图片层用占位图） */
  async function exportPsdTemplate(existing?: FileSystemFileHandle) {
    if (!currentUIData.value) throw new Error('当前没有打开的 UI 界面')
    const rawName = (currentFilePath.value.split('/').pop() || 'ui.json').replace(/\.json$/i, '')
    const suggested = `${sanitizeFsName(rawName) || 'ui'}.psd`
    const startIn = existing ?? (await latestRecentHandle('export-psd-template'))
    const handle =
      existing ??
      (await window.showSaveFilePicker({
        suggestedName: suggested,
        id: 'ui-editor-psd-template',
        startIn,
        types: [
          {
            description: 'Photoshop PSD',
            accept: { 'image/vnd.adobe.photoshop': ['.psd'], 'application/octet-stream': ['.psd'] },
          },
        ],
      }))
    const bytes = writePsdTemplateBytes(currentUIData.value)
    await writeBinaryFile(handle, bytes)
    await rememberRecentIo('export-psd-template', handle)
  }

  /**
   * 导出当前 UI 为 Cocos Creator 3.8 Prefab 资源包。
   * @param confirmOverwrite 目标目录已存在时询问是否覆盖；返回 false 则取消
   * @param onProgress 可选进度回调（进度框 / 日志；与引擎解耦）
   */
  async function exportCocosCreatorPrefab(
    confirmOverwrite?: (baseName: string) => Promise<boolean>,
    onProgress?: OnExportProgress,
    existingDir?: FileSystemDirectoryHandle,
  ) {
    if (!currentUIData.value) throw new Error('当前没有打开的 UI 界面')
    if (!project.dirHandle) throw new Error('请先新建或导入项目（导出需读取项目内图片）')

    const startIn = existingDir ?? (await latestRecentHandle('export-prefab'))
    const exportRoot =
      existingDir ??
      (await window.showDirectoryPicker({
        mode: 'readwrite',
        id: 'ui-editor-cocos-export',
        startIn,
      }))

    const rawName = (currentFilePath.value.split('/').pop() || 'ui.json').replace(/\.json$/i, '')
    const baseName = toExportBaseName(rawName)

    if (await pathExists(exportRoot, baseName)) {
      const ok = confirmOverwrite ? await confirmOverwrite(baseName) : true
      if (!ok) return null
      try {
        await removeEntryByPath(exportRoot, baseName)
      } catch (err) {
        console.warn(`[editor] 覆盖导出时删除旧包失败：${String(err)}`)
      }
    }

    const result = await exportCocosPrefab({
      exportRoot,
      baseName,
      root: currentUIData.value,
      readImage: (path) => project.getFileByPath(path),
      readText: async (p) => {
        const file = await project.getFileByPath(p)
        if (file) return file.text()
        const cached = getCachedTemplateMd(p)
        if (cached) return cached
        if (isAbsoluteFsPath(p)) {
          const local = await readLocalFsText(p)
          if (local) {
            rememberTemplateMd(p, local)
            return local
          }
          const picked = await pickLocalMarkdownText(p.split(/[/\\]/).pop())
          if (picked) {
            rememberTemplateMd(p, picked)
            return picked
          }
        }
        return null
      },
      componentDefs: project.componentDefs,
      onProgress,
    })
    await rememberRecentIo('export-prefab', exportRoot)
    return result
  }

  // ---------- 节点操作 ----------

  function addChild(parentId: string) {
    const parent = findNodeById(currentUIData.value, parentId)
    if (!parent) return
    const node = createNode(`Node_${parent.children.length + 1}`, parent.children.length)
    parent.children.push(node)
    commit()
    selectNode(node._id)
  }

  function duplicateNode(id: string) {
    duplicateNodes([id])
  }

  function duplicateNodes(ids: string[]) {
    const root = currentUIData.value
    if (!root) return
    const top = topLevelSelectedIds(root, ids, root._id)
    if (!top.length) return
    const copies: string[] = []
    for (const id of top) {
      const parent = findParentById(root, id)
      const node = findNodeById(root, id)
      if (!parent || !node) continue
      const copy = cloneWithNewIds(node)
      copy.name = `${node.name}_copy`
      const index = parent.children.indexOf(node)
      parent.children.splice(index + 1, 0, copy)
      copies.push(copy._id)
    }
    if (!copies.length) return
    reindexZ(root)
    commit()
    selectedIds.value = copies
    selectedId.value = copies[copies.length - 1] ?? null
  }

  function removeNode(id: string) {
    removeNodes([id])
  }

  function removeNodes(ids: string[]) {
    const root = currentUIData.value
    if (!root) return
    const top = topLevelSelectedIds(root, ids, root._id)
    if (!top.length) return
    const fallbackParent = findParentById(root, top[0]!)
    for (const id of top) detachChild(root, id)
    reindexZ(root)
    commit()
    const next = fallbackParent && findNodeById(root, fallbackParent._id) ? fallbackParent._id : root._id
    selectNode(next)
  }

  /** 节点树拖拽结束后：按新顺序重排 zIndex 并提交历史（下标越大越靠上） */
  function afterTreeDrop() {
    if (!currentUIData.value) return
    reindexZ(currentUIData.value)
    commit()
  }

  /**
   * el-tree 已把拖动节点放到落点。若拖的是多选之一，把其余顶层选中节点接到同一父级、紧随其后。
   */
  function afterMultiTreeDrop(draggedId: string) {
    const root = currentUIData.value
    if (!root) return
    const top = topLevelSelectedIds(root, selectedIds.value, root._id)
    if (top.length <= 1 || !top.includes(draggedId)) {
      afterTreeDrop()
      return
    }
    const parent = findParentById(root, draggedId)
    if (!parent) {
      afterTreeDrop()
      return
    }
    const rest: UINode[] = []
    for (const id of top) {
      if (id === draggedId) continue
      if (id === parent._id || isStrictDescendant(root, id, parent._id)) continue
      const node = detachChild(root, id)
      if (node) rest.push(node)
    }
    const idx = parent.children.findIndex((c) => c._id === draggedId)
    parent.children.splice(Math.max(0, idx) + 1, 0, ...rest)
    afterTreeDrop()
  }

  // ---------- 组件操作 ----------

  function addComponent(nodeId: string, type: string) {
    const node = findNodeById(currentUIData.value, nodeId)
    const defs = project.componentDefs
    const def = defs[type]
    const isRoot = node === currentUIData.value
    if (!node || !def || !canAddComponent(node, type, defs, isRoot)) return
    const mounted = mountComponentOnNode(node, type, defs, isRoot, (msg) => {
      console.warn(`[editor] ${msg}`)
      ElMessage.warning(msg)
    })
    if (!mounted) return
    const data = node.components[type]!
    if (hasScriptBindProps(def)) {
      const latest = latestScriptBind(type)
      if (latest) {
        data.scriptPath = latest.scriptPath
        data.scriptUuid = latest.scriptUuid
      }
    }
    if (type === 'TemplateComponent') {
      const latestType = latestTemplateType()
      if (latestType) data.templateType = latestType
      const latestPath = latestTemplatePath()
      if (latestPath) data.templatePath = latestPath
      if (!isRoot) {
        const latestAlias = latestTemplateAlias()
        if (latestAlias) data.templateAlias = latestAlias
      }
    }
    if (type === 'ImgToFileComponent') {
      const latest = latestToFile()
      if (latest) data.toFile = latest
    }
    commit()
  }

  function removeComponent(nodeId: string, type: string) {
    const node = findNodeById(currentUIData.value, nodeId)
    if (!node || !node.components[type]) return
    delete node.components[type]
    if (type === 'SpriteComponent') delete node.components['ImgToFileComponent']
    commit()
  }

  /** 资源树移动后同步当前打开 UI 的 Sprite.framePath，并记入历史 */
  function remapOpenUiFramePaths(moved: { from: string; to: string }[]): boolean {
    if (!currentUIData.value || !moved.length) return false
    const changed = remapSpriteFramePaths(currentUIData.value, moved)
    if (changed) commit()
    return changed
  }

  return {
    currentUIData,
    currentFileHandle,
    currentFilePath,
    selectedId,
    selectedIds,
    selectedCount,
    selectedNode,
    rootId,
    isRootSelected,
    saveState,
    canUndo,
    canRedo,
    canvasWidth,
    canvasHeight,
    orientation,
    resolutionLabel,
    toggleOrientation,
    setResolution,
    ensureRootMatchesResolution,
    commit,
    undo,
    redo,
    scheduleSave,
    saveNow,
    loadUIFile,
    importUIFile,
    exportUIFile,
    exportPsdTemplate,
    exportCocosCreatorPrefab,
    addChild,
    duplicateNode,
    duplicateNodes,
    removeNode,
    removeNodes,
    afterTreeDrop,
    afterMultiTreeDrop,
    selectNode,
    setSelectedIds,
    addComponent,
    removeComponent,
    remapOpenUiFramePaths,
  }
})
