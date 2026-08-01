<script setup lang="ts">
import { ElMessage } from 'element-plus'
import type { FileEntry } from '../types'
import { useProjectStore } from '../stores/project'
import { useEditorStore } from '../stores/editor'

const project = useProjectStore()
const editor = useEditorStore()

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

/** 单击文件夹 → 资源管理器只显示该目录下图片；单击文件则不改过滤 */
function onClick(entry: FileEntry) {
  if (entry.kind === 'directory') {
    project.setAssetFolderFilter(entry.path)
  }
}
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
    <div class="min-h-0 flex-1 overflow-auto p-1">
      <el-tree
        v-if="project.fileTree.length"
        class="panel-tree"
        :data="project.fileTree"
        node-key="path"
        :props="{ label: 'name', children: 'children' }"
        :expand-on-click-node="false"
        highlight-current
        @node-click="onClick"
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
      <p v-else class="px-3 py-4 text-xs text-zinc-500">未挂载项目文件夹</p>
    </div>
  </section>
</template>
