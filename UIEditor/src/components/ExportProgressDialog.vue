<script setup lang="ts">
/**
 * 通用引擎 Prefab 导出进度框（与 Cocos / 其它引擎解耦，只展示进度事件）。
 */
defineProps<{
  modelValue: boolean
  title: string
  message: string
  percent: number
  current: number
  total: number
}>()

defineEmits<{
  'update:modelValue': [value: boolean]
}>()
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="420px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
    align-center
    append-to-body
  >
    <div class="space-y-3 py-1">
      <p class="text-sm text-zinc-300">{{ message }}</p>
      <el-progress :percentage="percent" :stroke-width="14" striped striped-flow />
      <p class="text-right text-xs text-zinc-500">
        {{ current }} / {{ total }}
      </p>
    </div>
  </el-dialog>
</template>
