<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useProjectStore } from '../stores/project'
import type { AssetEntry } from '../types'
import { isAdditiveClick } from '../utils/pointer'
import { writeImagePathsTransfer } from '../utils/imagePaths'

const project = useProjectStore()
const preview = ref<AssetEntry | null>(null)
const multiSelected = computed(() =>
  project.selectedAssetPaths.length > 1 ? new Set(project.selectedAssetPaths) : new Set<string>(),
)

const titleSuffix = computed(() =>
  project.assetFolderFilter ? ` · ${project.assetFolderFilter}` : ' · 全部',
)

function onWindowFocus() {
  void project.refreshAssets()
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') void project.refreshAssets()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && preview.value) {
    preview.value = null
  }
}

onMounted(() => {
  window.addEventListener('focus', onWindowFocus)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('focus', onWindowFocus)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('keydown', onKeydown)
})

function onAssetClick(e: MouseEvent, asset: AssetEntry) {
  if (isAdditiveClick(e)) {
    const set = new Set(project.selectedAssetPaths)
    if (set.has(asset.path)) set.delete(asset.path)
    else set.add(asset.path)
    project.selectedAssetPaths = [...set]
    return
  }
  project.selectedAssetPaths = [asset.path]
}

function onDragStart(e: DragEvent, asset: AssetEntry) {
  const selected = project.selectedAssetPaths
  const paths =
    selected.includes(asset.path) && selected.length > 1
      ? [asset.path, ...selected.filter((p) => p !== asset.path)]
      : [asset.path]
  writeImagePathsTransfer(e.dataTransfer, paths)
}

function openPreview(asset: AssetEntry) {
  preview.value = asset
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-zinc-900">
    <h3
      class="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-1.5 text-xs font-semibold tracking-wider text-zinc-400 select-none"
    >
      <span class="truncate">
        资源管理器（图片）{{ titleSuffix }}
        <span v-if="project.selectedAssetPaths.length > 1" class="font-normal text-sky-400">
          · {{ project.selectedAssetPaths.length }}
        </span>
      </span>
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
          class="flex w-20 shrink-0 cursor-grab flex-col items-center gap-1 rounded border bg-zinc-950 p-1.5 hover:border-sky-700 active:cursor-grabbing"
          :class="
            multiSelected.has(asset.path) ||
            (project.selectedAssetPaths.length === 1 && project.selectedAssetPaths[0] === asset.path)
              ? 'border-sky-600 bg-sky-950/40'
              : 'border-zinc-800'
          "
          draggable="true"
          :title="`${asset.path}（单击选中，Ctrl/⌘+点多选，双击放大）`"
          @click="onAssetClick($event, asset)"
          @dragstart="onDragStart($event, asset)"
          @dblclick.stop="openPreview(asset)"
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

    <Teleport to="body">
      <div
        v-if="preview"
        class="fixed inset-0 z-80 flex items-center justify-center bg-black/70 p-6"
        @click.self="preview = null"
      >
        <div class="flex max-h-full max-w-full flex-col items-center gap-2">
          <img
            :src="preview.url"
            :alt="preview.name"
            class="max-h-[min(90vh,900px)] max-w-[min(90vw,1200px)] object-contain shadow-2xl"
          />
          <p class="max-w-[90vw] truncate text-xs text-zinc-300">{{ preview.path }}</p>
          <button
            class="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
            @click="preview = null"
          >
            关闭（Esc）
          </button>
        </div>
      </div>
    </Teleport>
  </section>
</template>
