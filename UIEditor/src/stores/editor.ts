import { defineStore } from 'pinia'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import type { Orientation, UINode } from '../types'
import { readTextFile, writeTextFile } from '../utils/fs'
import {
  canAddComponent,
  cloneWithNewIds,
  createComponentData,
  createNode,
  findNodeById,
  findParentById,
  normalizeUIData,
  serializeForDisk,
} from '../utils/node'
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
  const canUndo = computed(() => past.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)
  const resolutionLabel = computed(() => `${canvasWidth.value}×${canvasHeight.value}`)

  function syncResolutionFromRoot(root: UINode) {
    canvasWidth.value = root.width
    canvasHeight.value = root.height
    orientation.value = root.width >= root.height ? 'landscape' : 'portrait'
  }

  /** 将设计分辨率应用到根节点宽高（坐标原点仍为画布中心） */
  function applyResolutionToRoot(width: number, height: number, pushHistory = true) {
    const root = currentUIData.value
    if (!root) {
      canvasWidth.value = width
      canvasHeight.value = height
      orientation.value = width >= height ? 'landscape' : 'portrait'
      return
    }
    if (root.width === width && root.height === height) {
      canvasWidth.value = width
      canvasHeight.value = height
      orientation.value = width >= height ? 'landscape' : 'portrait'
      return
    }
    root.width = width
    root.height = height
    canvasWidth.value = width
    canvasHeight.value = height
    orientation.value = width >= height ? 'landscape' : 'portrait'
    if (pushHistory) commit()
  }

  function toggleOrientation() {
    const w = canvasHeight.value
    const h = canvasWidth.value
    applyResolutionToRoot(w, h, true)
  }

  function setResolution(width: number, height: number) {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    applyResolutionToRoot(w, h, true)
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
    if (!findNodeById(currentUIData.value, selectedId.value)) {
      selectedId.value = currentUIData.value._id
    }
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
    syncResolutionFromRoot(data)
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

  // ---------- 节点操作 ----------

  function addChild(parentId: string) {
    const parent = findNodeById(currentUIData.value, parentId)
    if (!parent) return
    const node = createNode(`Node_${parent.children.length + 1}`, parent.children.length)
    parent.children.push(node)
    commit()
    selectedId.value = node._id
  }

  function duplicateNode(id: string) {
    if (!currentUIData.value || id === rootId.value) return
    const parent = findParentById(currentUIData.value, id)
    const node = findNodeById(currentUIData.value, id)
    if (!parent || !node) return
    const copy = cloneWithNewIds(node)
    copy.name = `${node.name}_copy`
    const index = parent.children.indexOf(node)
    parent.children.splice(index + 1, 0, copy)
    parent.children.forEach((c, i) => (c.zIndex = i))
    commit()
    selectedId.value = copy._id
  }

  function removeNode(id: string) {
    if (!currentUIData.value || id === rootId.value) return
    const parent = findParentById(currentUIData.value, id)
    if (!parent) return
    const index = parent.children.findIndex((c) => c._id === id)
    if (index < 0) return
    parent.children.splice(index, 1)
    commit()
    if (!findNodeById(currentUIData.value, selectedId.value)) {
      selectedId.value = parent._id
    }
  }

  /** 节点树拖拽结束后：按新顺序重排 zIndex 并提交历史（下标越大越靠上） */
  function afterTreeDrop() {
    if (!currentUIData.value) return
    const walk = (n: UINode) => {
      n.children.forEach((c, i) => {
        c.zIndex = i
        walk(c)
      })
    }
    walk(currentUIData.value)
    commit()
  }

  // ---------- 组件操作 ----------

  function addComponent(nodeId: string, type: string) {
    const node = findNodeById(currentUIData.value, nodeId)
    const def = project.componentDefs[type]
    if (!node || !def || !canAddComponent(node, type, project.componentDefs)) return
    node.components[type] = createComponentData(def)
    commit()
  }

  function removeComponent(nodeId: string, type: string) {
    const node = findNodeById(currentUIData.value, nodeId)
    if (!node || !node.components[type]) return
    delete node.components[type]
    commit()
  }

  return {
    currentUIData,
    currentFileHandle,
    currentFilePath,
    selectedId,
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
    commit,
    undo,
    redo,
    scheduleSave,
    saveNow,
    loadUIFile,
    importUIFile,
    exportUIFile,
    addChild,
    duplicateNode,
    removeNode,
    afterTreeDrop,
    addComponent,
    removeComponent,
  }
})
