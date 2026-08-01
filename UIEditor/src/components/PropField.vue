<script setup lang="ts">
import { computed } from 'vue'
import type { PropDef, Vec2 } from '../types'
import { parseVec2 } from '../utils/node'

const props = defineProps<{
  def: PropDef
  modelValue: unknown
  /** 是否作为资源拖放目标（SpriteComponent.framePath） */
  dropTarget?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: unknown]
  commit: []
}>()

const strValue = computed({
  get: () => (typeof props.modelValue === 'string' ? props.modelValue : String(props.modelValue ?? '')),
  set: (v: string) => emit('update:modelValue', v),
})

const numValue = computed({
  get: () => (typeof props.modelValue === 'number' ? props.modelValue : Number(props.modelValue) || 0),
  set: (v: number | undefined) => emit('update:modelValue', v ?? 0),
})

/** enum：只允许 options 内的 value（即 label 名）；兼容旧数字下标 */
const enumValue = computed({
  get: () => {
    const opts = props.def.options ?? []
    if (!opts.length) return ''
    const v = props.modelValue
    if (typeof v === 'string') {
      const hit = opts.find((o) => o.value === v || o.label === v)
      return hit?.value ?? opts[0].value
    }
    if (typeof v === 'number' && v >= 0 && v < opts.length) {
      return opts[v].value
    }
    return opts[0].value
  },
  set: (v: string) => {
    const opts = props.def.options ?? []
    const hit = opts.find((o) => o.value === v || o.label === v)
    emit('update:modelValue', hit?.value ?? opts[0]?.value ?? v)
  },
})

const boolValue = computed({
  get: () => Boolean(props.modelValue),
  set: (v: boolean) => emit('update:modelValue', v),
})

const vecValue = computed<Vec2>(() => parseVec2(props.modelValue))

function setVec(axis: 'x' | 'y', v: number | undefined) {
  emit('update:modelValue', { ...vecValue.value, [axis]: v ?? 0 })
}

function onDrop(e: DragEvent) {
  if (!props.dropTarget) return
  e.preventDefault()
  const path = e.dataTransfer?.getData('text/plain')
  if (path) {
    emit('update:modelValue', path)
    emit('commit')
  }
}
</script>

<template>
  <!-- string -->
  <div
    v-if="def.type === 'string'"
    :class="dropTarget ? 'rounded ring-1 ring-dashed ring-zinc-600' : ''"
    @dragover.prevent
    @drop="onDrop"
  >
    <el-input
      v-model="strValue"
      size="small"
      :placeholder="dropTarget ? '可从下方资源管理器拖入图片' : ''"
      @change="emit('commit')"
    />
  </div>

  <!-- number -->
  <el-input-number
    v-else-if="def.type === 'number'"
    v-model="numValue"
    size="small"
    class="w-full!"
    :min="def.min"
    :max="def.max"
    :step="def.step ?? 1"
    controls-position="right"
    @change="emit('commit')"
  />

  <!-- enum：固定选项，存 label 名（CUSTOM / SIMPLE …），禁止自由数字 -->
  <el-select
    v-else-if="def.type === 'enum'"
    v-model="enumValue"
    size="small"
    class="w-full!"
    :teleported="true"
    @change="emit('commit')"
  >
    <el-option
      v-for="opt in def.options ?? []"
      :key="opt.value"
      :label="opt.label"
      :value="opt.value"
    />
  </el-select>

  <!-- boolean -->
  <el-switch v-else-if="def.type === 'boolean'" v-model="boolValue" @change="emit('commit')" />

  <!-- color -->
  <el-color-picker
    v-else-if="def.type === 'color'"
    v-model="strValue"
    color-format="hex"
    @change="emit('commit')"
  />

  <!-- v2 -->
  <div v-else-if="def.type === 'v2'" class="flex gap-1">
    <el-input-number
      :model-value="vecValue.x"
      size="small"
      class="w-1/2!"
      controls-position="right"
      @update:model-value="setVec('x', $event ?? undefined)"
      @change="emit('commit')"
    />
    <el-input-number
      :model-value="vecValue.y"
      size="small"
      class="w-1/2!"
      controls-position="right"
      @update:model-value="setVec('y', $event ?? undefined)"
      @change="emit('commit')"
    />
  </div>

  <!-- 未知类型：只读 JSON -->
  <el-input v-else :model-value="JSON.stringify(modelValue)" size="small" disabled />
</template>
