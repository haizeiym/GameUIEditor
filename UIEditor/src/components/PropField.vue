<script setup lang="ts">
import { computed } from 'vue'
import type { PropDef, Vec2 } from '../types'
import { parseVec2 } from '../utils/node'

const props = defineProps<{
  def: PropDef
  modelValue: unknown
  /** 资源拖放：图片路径 / 脚本路径 */
  dropTarget?: 'image' | 'script' | 'markdown' | boolean
  /** type=node 时的节点下拉（`.` = 当前节点） */
  nodeOptions?: { label: string; value: string }[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: unknown]
  commit: []
  /** 脚本路径拖放（由 Inspector 做 .meta 校验与 UUID 回填） */
  'script-drop': [event: DragEvent]
}>()

const dropKind = computed(() => {
  if (props.dropTarget === true || props.dropTarget === 'image') return 'image'
  if (props.dropTarget === 'script') return 'script'
  if (props.dropTarget === 'markdown') return 'markdown'
  return null
})

const strValue = computed({
  get: () => (typeof props.modelValue === 'string' ? props.modelValue : String(props.modelValue ?? '')),
  set: (v: string) => emit('update:modelValue', v),
})

const numValue = computed({
  get: () => (typeof props.modelValue === 'number' ? props.modelValue : Number(props.modelValue) || 0),
  set: (v: number | undefined) => emit('update:modelValue', v ?? 0),
})

/** enum：只允许 options 内的 value（即 label 名）；缺省用 def.default，兼容旧数字下标 */
const enumValue = computed({
  get: () => {
    const opts = props.def.options ?? []
    if (!opts.length) return ''
    const fallback =
      typeof props.def.default === 'string'
        ? (opts.find((o) => o.value === props.def.default || o.label === props.def.default)?.value ??
          props.def.default)
        : opts[0].value
    const v = props.modelValue
    if (v === undefined || v === null || v === '') return fallback
    if (typeof v === 'string') {
      const hit = opts.find((o) => o.value === v || o.label === v)
      return hit?.value ?? fallback
    }
    if (typeof v === 'number' && v >= 0 && v < opts.length) {
      return opts[v].value
    }
    return fallback
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
  if (!dropKind.value) return
  e.preventDefault()
  if (dropKind.value === 'script' || dropKind.value === 'markdown') {
    emit('script-drop', e)
    return
  }
  const path = e.dataTransfer?.getData('text/plain')
  if (path) {
    emit('update:modelValue', path)
    emit('commit')
  }
}

const placeholder = computed(() => {
  if (dropKind.value === 'image') return '可从下方资源管理器拖入图片'
  if (dropKind.value === 'script')
    return '拖入 .ts 或 .ts.meta；Mac 上可再选同目录 .meta 文件'
  if (dropKind.value === 'markdown') return '拖入 .md、本机路径或 https://…/*.md'
  return ''
})

const nodeValue = computed({
  get: () => {
    const v = typeof props.modelValue === 'string' ? props.modelValue.trim() : ''
    return v === '' ? '.' : v
  },
  set: (v: string) => emit('update:modelValue', v || '.'),
})

const nodeSelectOptions = computed(() => {
  const opts = props.nodeOptions ?? []
  const v = nodeValue.value
  if (v && !opts.some((o) => o.value === v)) {
    return [{ label: v, value: v }, ...opts]
  }
  return opts
})
</script>

<template>
  <!-- string -->
  <div
    v-if="def.type === 'string'"
    :class="dropKind ? 'rounded ring-1 ring-dashed ring-zinc-600' : ''"
    @dragover.prevent
    @drop="onDrop"
  >
    <el-input
      v-model="strValue"
      size="small"
      :placeholder="placeholder"
      @dragover.prevent
      @drop.prevent.stop="onDrop"
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

  <!-- node：当前节点 + 子孙路径 -->
  <el-select
    v-else-if="def.type === 'node'"
    v-model="nodeValue"
    size="small"
    class="w-full!"
    filterable
    :teleported="true"
    @change="emit('commit')"
  >
    <el-option
      v-for="opt in nodeSelectOptions"
      :key="opt.value"
      :label="opt.label"
      :value="opt.value"
    />
  </el-select>

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
