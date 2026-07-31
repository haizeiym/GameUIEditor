<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import TopBar from './components/TopBar.vue'
import NodeTree from './components/NodeTree.vue'
import FileTree from './components/FileTree.vue'
import StageCanvas from './components/StageCanvas.vue'
import Inspector from './components/Inspector.vue'
import AssetPanel from './components/AssetPanel.vue'
import { useEditorStore } from './stores/editor'

const editor = useEditorStore()

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

function onKeydown(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey)) return
  const key = e.key.toLowerCase()
  if (key !== 'z' && key !== 'y') return
  // 输入框内保留浏览器原生撤销
  if (isEditableTarget(e.target)) return
  e.preventDefault()
  if (key === 'y' || (key === 'z' && e.shiftKey)) {
    void editor.redo()
  } else {
    void editor.undo()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="flex h-screen flex-col bg-zinc-900 text-zinc-200">
    <TopBar />
    <div class="flex min-h-0 flex-1">
      <!-- 左侧：节点树 + 项目文件 -->
      <aside class="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900">
        <NodeTree class="min-h-0 flex-[3] border-b border-zinc-800" />
        <FileTree class="min-h-0 flex-[2]" />
      </aside>

      <!-- 中间：画布 + 底部资源管理器 -->
      <main class="flex min-w-0 flex-1 flex-col">
        <StageCanvas class="min-h-0 flex-1" />
        <AssetPanel class="h-44 shrink-0 border-t border-zinc-800" />
      </main>

      <!-- 右侧：属性面板 -->
      <aside class="w-80 shrink-0 overflow-y-auto border-l border-zinc-800 bg-zinc-900">
        <Inspector />
      </aside>
    </div>
  </div>
</template>
