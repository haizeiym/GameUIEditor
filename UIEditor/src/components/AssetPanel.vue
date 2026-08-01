<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useProjectStore } from '../stores/project'
import type { AssetEntry } from '../types'

const project = useProjectStore()

const titleSuffix = computed(() =>
  project.assetFolderFilter ? ` · ${project.assetFolderFilter}` : ' · 全部',
)

/** 页面重新聚焦时轮询项目文件夹，模拟文件监听 */
function onWindowFocus() {
  void project.refreshAssets()
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') void project.refreshAssets()
}

onMounted(() => {
  window.addEventListener('focus', onWindowFocus)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('focus', onWindowFocus)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

function onDragStart(e: DragEvent, asset: AssetEntry) {
  e.dataTransfer?.setData('text/plain', asset.path)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}
</script>

<template>
  <section class="flex flex-col bg-zinc-900">
    <h3
      class="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-1.5 text-xs font-semibold tracking-wider text-zinc-400 select-none"
    >
      <span class="truncate">资源管理器（图片）{{ titleSuffix }}</span>
      <span class="flex shrink-0 items-center gap-1">
        <button
          v-if="project.assetFolderFilter"
          class="rounded px-1.5 py-0.5 text-[11px] font-normal text-sky-400 hover:bg-zinc-800"
          @click="project.clearAssetFolderFilter()"
        >
          显示全部
        </button>
        <button
          v-if="project.dirHandle"
          class="rounded px-1.5 py-0.5 text-[11px] font-normal text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          @click="project.refreshAssets(true)"
        >
          手动刷新
        </button>
      </span>
    </h3>

    <div class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
      <p v-if="!project.dirHandle" class="px-3 py-4 text-xs text-zinc-500">
        挂载项目后，这里会显示项目内的 .png / .jpg / .webp 图片；点击左侧文件夹可只看该目录
      </p>
      <p v-else-if="!project.filteredAssets.length" class="px-3 py-4 text-xs text-zinc-500">
        {{
          project.assetFolderFilter
            ? `文件夹 "${project.assetFolderFilter}" 内暂无图片`
            : '项目内暂无图片资源'
        }}
      </p>
      <div v-else class="flex h-full items-start gap-2 p-2">
        <div
          v-for="asset in project.filteredAssets"
          :key="asset.path"
          class="flex w-20 shrink-0 cursor-grab flex-col items-center gap-1 rounded border border-zinc-800 bg-zinc-950 p-1.5 hover:border-sky-700 active:cursor-grabbing"
          draggable="true"
          :title="asset.path"
          @dragstart="onDragStart($event, asset)"
        >
          <div
            class="flex h-14 w-full items-center justify-center overflow-hidden rounded bg-[repeating-conic-gradient(#27272a_0%_25%,#1c1c1f_0%_50%)] bg-size-[12px_12px]"
          >
            <img :src="asset.url" class="max-h-full max-w-full object-contain" draggable="false" />
          </div>
          <span class="w-full truncate text-center text-[10px] text-zinc-400">
            {{ asset.name }}
          </span>
        </div>
      </div>
    </div>
  </section>
</template>
