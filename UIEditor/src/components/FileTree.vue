<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FileEntry } from '../types'
import { useProjectStore } from '../stores/project'
import { useEditorStore } from '../stores/editor'

const project = useProjectStore()
const editor = useEditorStore()

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
  const parts = menu.entry.path.split('/')
  parts.pop()
  return parts.join('/')
})

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

/** 单击文件夹 → 资源管理器只显示该目录下图片 */
function onClick(entry: FileEntry) {
  if (entry.kind === 'directory') {
    project.setAssetFolderFilter(entry.path)
  }
}

function onContextMenu(event: MouseEvent, data: FileEntry) {
  event.preventDefault()
  event.stopPropagation()
  menu.entry = data
  menu.x = event.clientX
  menu.y = event.clientY
  menu.visible = true
  if (data.kind === 'directory') {
    project.setAssetFolderFilter(data.path)
  }
}

function onPanelContextMenu(event: MouseEvent) {
  // 空白处右键：针对项目根
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
  const entry = menu.entry
  closeMenu()
  if (!entry) {
    ElMessage.warning('请先选中要删除的文件或文件夹')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定删除「${entry.path}」${entry.kind === 'directory' ? '及其全部内容' : ''}？此操作不可撤销。`,
      '删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    // 若删除的是当前打开的 UI 或其父目录，清空编辑器
    const opened = editor.currentFilePath
    if (
      opened &&
      (opened === entry.path || opened.startsWith(`${entry.path}/`))
    ) {
      editor.currentUIData = null
      editor.currentFileHandle = null
      editor.currentFilePath = ''
      editor.selectedId = null
    }
    await project.deleteEntry(entry.path)
    ElMessage.success(`已删除 ${entry.path}`)
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
      项目文件
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
        @node-click="onClick"
        @node-contextmenu="onContextMenu"
      >
        <template #default="{ data }">
          <span
            class="flex items-center gap-1 truncate text-[13px]"
            :class="{
              'text-amber-300': (data as FileEntry).kind === 'directory',
              'font-semibold text-amber-200':
                (data as FileEntry).kind === 'directory' &&
                project.assetFolderFilter === (data as FileEntry).path,
              'text-sky-300':
                (data as FileEntry).kind === 'file' && (data as FileEntry).name.endsWith('.json'),
              'font-semibold': editor.currentFilePath === (data as FileEntry).path,
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
          class="block w-full px-4 py-1.5 text-left text-red-400 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-600"
          :disabled="!menu.entry"
          @click="onDelete"
        >
          删除
        </button>
      </div>
    </Teleport>
  </section>
</template>
