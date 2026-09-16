<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type Node from 'element-plus/es/components/tree/src/model/node'
import type { FileEntry } from '../types'
import { useProjectStore } from '../stores/project'
import { useEditorStore } from '../stores/editor'
import { applyMovedAssetPath, getFileHandleByPath, isImageFile, parentDirPath, topLevelEntryPaths } from '../utils/fs'
import { mergeImagePaths, writeImagePathsTransfer } from '../utils/imagePaths'
import { isAdditiveClick } from '../utils/pointer'

const project = useProjectStore()
const editor = useEditorStore()
const checkedPaths = computed({
  get: () => project.selectedEntryPaths,
  set: (v: string[]) => {
    project.selectedEntryPaths = v
  },
})
const multiSelectedPaths = computed(() =>
  checkedPaths.value.length > 1 ? new Set(checkedPaths.value) : new Set<string>(),
)

const menu = reactive({
  visible: false,
  x: 0,
  y: 0,
  /** 右键目标；null 表示点在空白处，操作落在项目根 */
  entry: null as FileEntry | null,
})

const menuParentPath = computed(() => {
  if (!menu.entry) return ''
  if (menu.entry.kind === 'directory') return menu.entry.path
  return parentDirPath(menu.entry.path)
})

const menuBatchPaths = computed(() => {
  const target = menu.entry?.path
  if (!target) return [] as string[]
  const raw =
    checkedPaths.value.includes(target) && checkedPaths.value.length > 1
      ? checkedPaths.value
      : [target]
  return topLevelEntryPaths(raw)
})

const menuImagePaths = computed(() =>
  menuBatchPaths.value.filter((p) => isImageFile(p.split('/').pop() || '')),
)

async function onDblClick(entry: FileEntry) {
  if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.json')) return
  if (entry.name === 'components.json') {
    ElMessage.info('components.json 请通过顶部「编辑组件库」修改')
    return
  }
  const ok = await editor.loadUIFile(entry.handle as FileSystemFileHandle, entry.path)
  if (ok) {
    ElMessage.success(`已打开 ${entry.path}`)
  } else {
    ElMessage.error(`${entry.name} 不是合法的 UI 节点 JSON`)
  }
}

function onClick(entry: FileEntry, ...rest: unknown[]) {
  const additive = isAdditiveClick(...rest)
  if (additive) {
    const set = new Set(checkedPaths.value)
    if (set.has(entry.path)) set.delete(entry.path)
    else set.add(entry.path)
    checkedPaths.value = [...set]
  } else {
    checkedPaths.value = [entry.path]
  }
  if (entry.kind === 'directory') {
    project.setAssetFolderFilter(entry.path)
  }
}

function movingPaths(dragging: Node): string[] {
  const src = (dragging.data as FileEntry).path
  const raw = checkedPaths.value.includes(src) && checkedPaths.value.length > 1
    ? checkedPaths.value
    : [src]
  return topLevelEntryPaths(raw)
}

function onTreeDragStart(dragging: Node, ev: DragEvent) {
  const src = (dragging.data as FileEntry).path
  const raw =
    checkedPaths.value.includes(src) && checkedPaths.value.length > 1
      ? checkedPaths.value
      : [src]
  const images = raw.filter((p) => isImageFile(p.split('/').pop() || ''))
  if (!images.length) return
  const ordered = images.includes(src) ? [src, ...images.filter((p) => p !== src)] : images
  writeImagePathsTransfer(ev.dataTransfer, ordered)
}

function allowDrop(dragging: Node, dropNode: Node, type: 'prev' | 'inner' | 'next'): boolean {
  const dest = dropNode.data as FileEntry
  if (type === 'inner' && dest.kind !== 'directory') return false
  const moving = movingPaths(dragging)
  const innerPath = type === 'inner' && dest.kind === 'directory' ? dest.path : parentDirPath(dest.path)
  for (const p of moving) {
    if (dest.path === p || dest.path.startsWith(`${p}/`)) return false
    if (innerPath === p || (innerPath && innerPath.startsWith(`${p}/`))) return false
  }
  return true
}

function applyOpenedRemap(moved: { from: string; to: string }[]) {
  const opened = editor.currentFilePath
  if (!opened) return
  const next = applyMovedAssetPath(opened, moved)
  if (next === opened) return
  editor.currentFilePath = next
  void (async () => {
    if (!project.dirHandle) return
    const handle = await getFileHandleByPath(project.dirHandle, next)
    editor.currentFileHandle = handle
  })()
}

async function onNodeDrop(dragging: Node, dropNode: Node, type: 'prev' | 'inner' | 'next') {
  const dest = dropNode.data as FileEntry
  const destDir =
    type === 'inner' && dest.kind === 'directory' ? dest.path : parentDirPath(dest.path)
  const srcs = movingPaths(dragging)
  try {
    const moved = await project.moveEntries(srcs, destDir)
    applyOpenedRemap(moved)
    const openChanged = editor.remapOpenUiFramePaths(moved)
    const files = await project.rewriteSpriteFramePathsInUiFiles(moved, editor.currentFilePath)
    checkedPaths.value = moved.map((m) => m.to)
    if (moved.length) {
      const extra = openChanged || files > 0 ? '，已同步 Sprite 贴图路径' : ''
      ElMessage.success(`已移动 ${moved.length} 项${extra}`)
    }
  } catch (err) {
    ElMessage.error(`移动失败：${String(err)}`)
    await project.refreshFileTree()
  }
}

function onContextMenu(event: MouseEvent, data: FileEntry) {
  event.preventDefault()
  event.stopPropagation()
  menu.entry = data
  menu.x = event.clientX
  menu.y = event.clientY
  menu.visible = true
  if (!checkedPaths.value.includes(data.path)) {
    checkedPaths.value = [data.path]
  }
  if (data.kind === 'directory') {
    project.setAssetFolderFilter(data.path)
  }
}

function onPanelContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target.closest('.el-tree-node')) return
  event.preventDefault()
  menu.entry = null
  menu.x = event.clientX
  menu.y = event.clientY
  menu.visible = true
}

function closeMenu() {
  menu.visible = false
}

function onAddToFileArray() {
  const paths = menuImagePaths.value
  closeMenu()
  const node = editor.selectedNode
  const inst = node?.components['ImgToFileComponent']
  if (!inst) {
    ElMessage.info('请先选中带 ImgToFileComponent 的节点')
    return
  }
  if (!paths.length) {
    ElMessage.info('请选择图片文件（.png / .jpg / .webp）')
    return
  }
  const before = Array.isArray(inst.fileArray) ? inst.fileArray.length : 0
  inst.fileArray = mergeImagePaths(inst.fileArray, paths)
  const added = (inst.fileArray as string[]).length - before
  editor.commit()
  ElMessage.success(added > 0 ? `已加入 ${added} 张图片` : '所选图片已在数组中')
}

async function onNewFolder() {
  closeMenu()
  if (!project.dirHandle) {
    ElMessage.warning('请先打开项目')
    return
  }
  try {
    const parentLabel = menuParentPath.value || '项目根目录'
    const { value } = await ElMessageBox.prompt(`在「${parentLabel}」下新建文件夹`, '新建文件夹', {
      inputPattern: /^[\w\-\u4e00-\u9fa5.]+$/,
      inputErrorMessage: '名称不合法',
      inputValue: 'NewFolder',
      confirmButtonText: '创建',
      cancelButtonText: '取消',
    })
    const path = await project.createFolder(menuParentPath.value, value)
    project.setAssetFolderFilter(path)
    ElMessage.success(`已创建文件夹 ${path}`)
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(`新建文件夹失败：${String(err)}`)
  }
}

async function onDelete() {
  const paths = menuBatchPaths.value
  closeMenu()
  if (!paths.length) {
    ElMessage.warning('请先选中要删除的文件或文件夹')
    return
  }
  try {
    await ElMessageBox.confirm(
      paths.length > 1
        ? `确定删除选中的 ${paths.length} 项（文件夹含全部内容）？此操作不可撤销。`
        : `确定删除「${paths[0]}」${menu.entry?.kind === 'directory' ? '及其全部内容' : ''}？此操作不可撤销。`,
      '删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    const opened = editor.currentFilePath
    for (const path of paths) {
      if (opened && (opened === path || opened.startsWith(`${path}/`))) {
        editor.currentUIData = null
        editor.currentFileHandle = null
        editor.currentFilePath = ''
        editor.selectNode(null)
      }
      await project.deleteEntry(path)
    }
    ElMessage.success(paths.length > 1 ? `已删除 ${paths.length} 项` : `已删除 ${paths[0]}`)
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(`删除失败：${String(err)}`)
  }
}

onMounted(() => window.addEventListener('click', closeMenu))
onBeforeUnmount(() => window.removeEventListener('click', closeMenu))
</script>

<template>
  <section class="flex flex-col">
    <h3
      class="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-1.5 text-xs font-semibold tracking-wider text-zinc-400 select-none"
    >
      <span>
        项目文件
        <span v-if="checkedPaths.length > 1" class="ml-1 font-normal text-sky-400">
          · {{ checkedPaths.length }}
        </span>
      </span>
      <button
        v-if="project.dirHandle"
        class="rounded px-1.5 py-0.5 text-[11px] font-normal text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        @click="project.refreshFileTree()"
      >
        刷新
      </button>
    </h3>
    <div
      class="min-h-0 flex-1 overflow-auto p-1"
      @contextmenu="onPanelContextMenu"
    >
      <el-tree
        v-if="project.fileTree.length"
        class="panel-tree"
        :data="project.fileTree"
        node-key="path"
        :props="{ label: 'name', children: 'children' }"
        :expand-on-click-node="false"
        highlight-current
        draggable
        :allow-drop="allowDrop"
        @node-click="onClick"
        @node-drag-start="onTreeDragStart"
        @node-drop="onNodeDrop"
        @node-contextmenu="onContextMenu"
      >
        <template #default="{ data }">
          <span
            class="tree-label flex items-center gap-1 truncate text-[13px]"
            :class="{
              'text-amber-300': (data as FileEntry).kind === 'directory',
              'font-semibold text-amber-200':
                (data as FileEntry).kind === 'directory' &&
                project.assetFolderFilter === (data as FileEntry).path,
              'text-sky-300':
                (data as FileEntry).kind === 'file' && (data as FileEntry).name.endsWith('.json'),
              'font-semibold': editor.currentFilePath === (data as FileEntry).path,
              'is-multi-selected': multiSelectedPaths.has((data as FileEntry).path),
            }"
            @dblclick="onDblClick(data as FileEntry)"
          >
            {{ (data as FileEntry).kind === 'directory' ? '📁' : '📄' }}
            {{ (data as FileEntry).name }}
          </span>
        </template>
      </el-tree>
      <p v-else class="px-3 py-4 text-xs text-zinc-500">
        未挂载项目文件夹（空白处右键可新建文件夹）
      </p>
    </div>

    <Teleport to="body">
      <div
        v-if="menu.visible"
        class="fixed z-50 min-w-36 rounded-md border border-zinc-700 bg-zinc-800 py-1 text-[13px] shadow-xl"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @click.stop
      >
        <button class="block w-full px-4 py-1.5 text-left hover:bg-zinc-700" @click="onNewFolder">
          新建文件夹
          <span v-if="menu.entry?.kind === 'directory'" class="ml-1 text-[11px] text-zinc-500">
            （内部）
          </span>
          <span v-else-if="menu.entry" class="ml-1 text-[11px] text-zinc-500">（同级）</span>
          <span v-else class="ml-1 text-[11px] text-zinc-500">（根目录）</span>
        </button>
        <button
          class="block w-full px-4 py-1.5 text-left hover:bg-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-600"
          :disabled="!menuImagePaths.length"
          @click="onAddToFileArray"
        >
          加入图片数组
          <span v-if="menuImagePaths.length" class="text-zinc-500">
            ({{ menuImagePaths.length }})
          </span>
        </button>
        <button
          class="block w-full px-4 py-1.5 text-left text-red-400 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-600"
          :disabled="!menu.entry"
          @click="onDelete"
        >
          删除
          <span v-if="menuBatchPaths.length > 1" class="text-zinc-500">
            ({{ menuBatchPaths.length }})
          </span>
        </button>
      </div>
    </Teleport>
  </section>
</template>
