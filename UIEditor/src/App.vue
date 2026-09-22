<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import TopBar from './components/TopBar.vue'
import NodeTree from './components/NodeTree.vue'
import FileTree from './components/FileTree.vue'
import StageCanvas from './components/StageCanvas.vue'
import Inspector from './components/Inspector.vue'
import AssetPanel from './components/AssetPanel.vue'
import { useEditorStore } from './stores/editor'
import {
  DEFAULT_PANEL_LAYOUT,
  loadPanelLayout,
  normalizePanelLayout,
  savePanelLayout,
  subscribePanelLayout,
  type PanelLayout,
} from './utils/panelLayout'

const editor = useEditorStore()

const workspaceEl = ref<HTMLElement | null>(null)
const leftW = ref(DEFAULT_PANEL_LAYOUT.left)
const rightW = ref(DEFAULT_PANEL_LAYOUT.right)
const bottomH = ref(DEFAULT_PANEL_LAYOUT.bottom)
const fileH = ref(DEFAULT_PANEL_LAYOUT.file)
const dragging = ref<'left' | 'right' | 'bottom' | 'file' | null>(null)

type DragKind = 'left' | 'right' | 'bottom' | 'file'

let drag: { kind: DragKind; start: number; startSize: number } | null = null
let unsubLayout: (() => void) | null = null

function workspaceSize(): { width: number; height: number } {
  const el = workspaceEl.value
  return {
    width: el?.clientWidth || window.innerWidth,
    height: el?.clientHeight || Math.max(window.innerHeight - 48, 1),
  }
}

function fit(partial: Partial<PanelLayout>): PanelLayout {
  return normalizePanelLayout(
    {
      left: partial.left ?? leftW.value,
      right: partial.right ?? rightW.value,
      bottom: partial.bottom ?? bottomH.value,
      file: partial.file ?? fileH.value,
    },
    workspaceSize(),
  )
}

function applyLayout(next: PanelLayout) {
  const fitted = savePanelLayout(next, workspaceSize())
  applyLayoutNoSave(fitted)
}

function applyLayoutNoSave(next: PanelLayout) {
  leftW.value = next.left
  rightW.value = next.right
  bottomH.value = next.bottom
  fileH.value = next.file
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

function onKeydown(e: KeyboardEvent) {
  if (isEditableTarget(e.target)) return
  if (e.key === 'Delete') {
    if (!editor.currentUIData || editor.isRootSelected) return
    e.preventDefault()
    const n = editor.selectedIds.filter((id) => id !== editor.rootId).length
    if (!n) return
    void ElMessageBox.confirm(
      n > 1 ? `确定删除选中的 ${n} 个节点及其子节点？` : '确定删除该节点及其子节点？',
      '删除节点',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
      .then(() => editor.removeNodes(editor.selectedIds))
      .catch(() => {})
    return
  }
  if (!(e.ctrlKey || e.metaKey)) return
  const key = e.key.toLowerCase()
  if (key !== 'z' && key !== 'y') return
  e.preventDefault()
  if (key === 'y' || (key === 'z' && e.shiftKey)) {
    void editor.redo()
  } else {
    void editor.undo()
  }
}

function onSplitterDown(kind: DragKind, e: PointerEvent) {
  e.preventDefault()
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 无真实指针时忽略 */
  }
  const vertical = kind === 'bottom' || kind === 'file'
  const start = vertical ? e.clientY : e.clientX
  const startSize =
    kind === 'left' ? leftW.value : kind === 'right' ? rightW.value : kind === 'file' ? fileH.value : bottomH.value
  drag = { kind, start, startSize }
  dragging.value = kind
  window.addEventListener('pointermove', onSplitterMove)
  window.addEventListener('pointerup', onSplitterUp)
  window.addEventListener('pointercancel', onSplitterUp)
}

function onSplitterMove(e: PointerEvent) {
  if (!drag) return
  const vertical = drag.kind === 'bottom' || drag.kind === 'file'
  const pos = vertical ? e.clientY : e.clientX
  const delta = pos - drag.start
  if (drag.kind === 'left') {
    applyLayoutNoSave(fit({ left: drag.startSize + delta }))
    return
  }
  if (drag.kind === 'right') {
    applyLayoutNoSave(fit({ right: drag.startSize - delta }))
    return
  }
  if (drag.kind === 'file') {
    applyLayoutNoSave(fit({ file: drag.startSize - delta }))
    return
  }
  applyLayoutNoSave(fit({ bottom: drag.startSize - delta }))
}

function onSplitterUp() {
  if (!drag) return
  drag = null
  dragging.value = null
  window.removeEventListener('pointermove', onSplitterMove)
  window.removeEventListener('pointerup', onSplitterUp)
  window.removeEventListener('pointercancel', onSplitterUp)
  applyLayout({ left: leftW.value, right: rightW.value, bottom: bottomH.value, file: fileH.value })
}

function onWinResize() {
  applyLayout({ left: leftW.value, right: rightW.value, bottom: bottomH.value, file: fileH.value })
}

onMounted(() => {
  applyLayoutNoSave(loadPanelLayout(workspaceSize()))
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onWinResize)
  unsubLayout = subscribePanelLayout((layout) => {
    applyLayoutNoSave(normalizePanelLayout(layout, workspaceSize()))
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', onWinResize)
  window.removeEventListener('pointermove', onSplitterMove)
  window.removeEventListener('pointerup', onSplitterUp)
  window.removeEventListener('pointercancel', onSplitterUp)
  unsubLayout?.()
})
</script>

<template>
  <div class="flex h-screen flex-col bg-zinc-900 text-zinc-200">
    <TopBar />
    <div ref="workspaceEl" class="flex min-h-0 flex-1" :class="dragging ? 'select-none' : ''">
      <!-- 左侧：节点树 + 项目文件 -->
      <aside
        class="relative flex shrink-0 flex-col border-r border-zinc-800 bg-zinc-900"
        :style="{ width: `${leftW}px` }"
      >
        <NodeTree class="min-h-0 flex-1" />
        <div class="relative shrink-0" :style="{ height: `${fileH}px` }">
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整项目文件树高度"
            class="absolute top-0 right-0 left-0 z-30 h-1.5 cursor-row-resize touch-none hover:bg-sky-500/40"
            :class="dragging === 'file' ? 'bg-sky-500/50' : ''"
            title="拖动调整项目文件树高度"
            tabindex="0"
            @pointerdown="onSplitterDown('file', $event)"
          >
            <span class="sr-only">调整项目文件树高度</span>
          </div>
          <FileTree class="h-full border-t border-zinc-800" />
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左栏宽度"
          class="absolute top-0 right-0 z-20 h-full w-1.5 cursor-col-resize touch-none hover:bg-sky-500/40"
          :class="dragging === 'left' ? 'bg-sky-500/50' : ''"
          title="拖动调整左栏宽度"
          tabindex="0"
          @pointerdown="onSplitterDown('left', $event)"
        >
          <span class="sr-only">调整左栏宽度</span>
        </div>
      </aside>

      <!-- 中间：画布 + 底部资源管理器 -->
      <main class="flex min-w-0 flex-1 flex-col">
        <StageCanvas class="min-h-0 min-w-0 flex-1" />
        <div class="relative shrink-0 border-t border-zinc-800" :style="{ height: `${bottomH}px` }">
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整资源栏高度"
            class="absolute top-0 right-0 left-0 z-20 h-1.5 cursor-row-resize touch-none hover:bg-sky-500/40"
            :class="dragging === 'bottom' ? 'bg-sky-500/50' : ''"
            title="拖动调整资源栏高度"
            tabindex="0"
            @pointerdown="onSplitterDown('bottom', $event)"
          >
            <span class="sr-only">调整资源栏高度</span>
          </div>
          <AssetPanel class="h-full" />
        </div>
      </main>

      <!-- 右侧：属性面板 -->
      <aside
        class="relative shrink-0 overflow-y-auto border-l border-zinc-800 bg-zinc-900"
        :style="{ width: `${rightW}px` }"
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右栏宽度"
          class="absolute top-0 left-0 z-20 h-full w-1.5 cursor-col-resize touch-none hover:bg-sky-500/40"
          :class="dragging === 'right' ? 'bg-sky-500/50' : ''"
          title="拖动调整右栏宽度"
          tabindex="0"
          @pointerdown="onSplitterDown('right', $event)"
        >
          <span class="sr-only">调整右栏宽度</span>
        </div>
        <Inspector />
      </aside>
    </div>
  </div>
</template>
