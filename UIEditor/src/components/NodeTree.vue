<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { ElTree } from 'element-plus'
import type Node from 'element-plus/es/components/tree/src/model/node'
import type { UINode } from '../types'
import { useEditorStore } from '../stores/editor'
import { collectNodeIds, pruneExpandedKeys } from '../utils/nodeTreeExpand'
import { findNodeById, isStrictDescendant, topLevelSelectedIds } from '../utils/node'
import { isAdditiveClick } from '../utils/pointer'

const editor = useEditorStore()
const treeRef = ref<InstanceType<typeof ElTree>>()

const treeData = computed<UINode[]>(() => (editor.currentUIData ? [editor.currentUIData] : []))
const multiSelected = computed(() => new Set(editor.selectedIds))

const expandedKeys = ref<string[]>([])

/** 打开 / 切换 UI：默认全展开 */
watch(
  () => editor.rootId,
  (id) => {
    const root = editor.currentUIData
    expandedKeys.value = id && root ? collectNodeIds(root) : []
  },
  { immediate: true },
)

/** 同 UI 内增删节点：只剪掉失效 key，不因新建而加入父 id */
watch(
  () => editor.currentUIData,
  (root) => {
    if (!root) {
      expandedKeys.value = []
      return
    }
    if (root._id !== editor.rootId) return
    expandedKeys.value = pruneExpandedKeys(expandedKeys.value, root)
  },
  { deep: true },
)

function onNodeExpand(data: UINode) {
  if (!expandedKeys.value.includes(data._id)) {
    expandedKeys.value = [...expandedKeys.value, data._id]
  }
}

function onNodeCollapse(data: UINode) {
  expandedKeys.value = expandedKeys.value.filter((k) => k !== data._id)
}

watch(
  () => [editor.selectedId, editor.currentUIData] as const,
  async () => {
    await nextTick()
    if (editor.selectedId) treeRef.value?.setCurrentKey(editor.selectedId, false)
  },
  { immediate: true },
)

function onNodeClick(data: UINode, ...rest: unknown[]) {
  editor.selectNode(data._id, isAdditiveClick(...rest))
}

const editingId = ref<string | null>(null)
const editingName = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

async function beginRename(node: UINode) {
  editingId.value = node._id
  editingName.value = node.name
  editor.selectNode(node._id)
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}

function finishRename(save: boolean) {
  const id = editingId.value
  if (!id) return
  const raw = editingName.value
  editingId.value = null
  if (!save) return
  const node = findNodeById(editor.currentUIData, id)
  const next = raw.trim()
  if (!node || !next || next === node.name) return
  node.name = next
  editor.commit()
}

function allowDrag(node: Node): boolean {
  return (node.data as UINode)._id !== editor.rootId
}

function movingIds(dragging: Node): string[] {
  const root = editor.currentUIData
  if (!root) return []
  const dragId = (dragging.data as UINode)._id
  const raw = editor.selectedIds.includes(dragId)
    ? editor.selectedIds
    : [dragId]
  return topLevelSelectedIds(root, raw, root._id)
}

function allowDrop(dragging: Node, dropNode: Node, type: 'prev' | 'inner' | 'next'): boolean {
  const drop = dropNode.data as UINode
  if (drop._id === editor.rootId) return type === 'inner'
  const root = editor.currentUIData
  if (!root) return false
  for (const id of movingIds(dragging)) {
    if (drop._id === id || isStrictDescendant(root, id, drop._id)) return false
  }
  return true
}

function onNodeDrop(dragging: Node) {
  editor.afterMultiTreeDrop((dragging.data as UINode)._id)
}

const menu = reactive({ visible: false, x: 0, y: 0, nodeId: '' })
const menuIsRoot = computed(() => menu.nodeId === editor.rootId)
const menuBatchIds = computed(() => {
  const root = editor.currentUIData
  if (!root) return [] as string[]
  const raw =
    editor.selectedIds.includes(menu.nodeId) && editor.selectedIds.length > 1
      ? editor.selectedIds
      : [menu.nodeId]
  return topLevelSelectedIds(root, raw, root._id)
})
const menuBatchCount = computed(() => menuBatchIds.value.length)

function onContextMenu(event: MouseEvent, data: UINode) {
  event.preventDefault()
  if (!editor.selectedIds.includes(data._id)) editor.selectNode(data._id)
  else editor.selectedId = data._id
  menu.nodeId = data._id
  menu.x = event.clientX
  menu.y = event.clientY
  menu.visible = true
}

function closeMenu() {
  menu.visible = false
}

function menuAddChild() {
  editor.addChild(menu.nodeId)
  closeMenu()
}

function menuDuplicate() {
  if (!menuBatchCount.value) {
    closeMenu()
    return
  }
  editor.duplicateNodes(menuBatchIds.value)
  closeMenu()
}

async function menuRemove() {
  const ids = menuBatchIds.value
  closeMenu()
  if (!ids.length) return
  try {
    await ElMessageBox.confirm(
      ids.length > 1
        ? `确定删除选中的 ${ids.length} 个节点及其子节点？`
        : '确定删除该节点及其子节点？',
      '删除节点',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    editor.removeNodes(ids)
  } catch {
    /* 取消 */
  }
}

onMounted(() => window.addEventListener('click', closeMenu))
onBeforeUnmount(() => window.removeEventListener('click', closeMenu))
</script>

<template>
  <section class="flex flex-col">
    <h3 class="shrink-0 border-b border-zinc-800 px-3 py-1.5 text-xs font-semibold tracking-wider text-zinc-400 select-none">
      节点树
      <span v-if="editor.selectedCount > 1" class="ml-1 font-normal text-sky-400">
        · {{ editor.selectedCount }}
      </span>
    </h3>
    <div class="min-h-0 flex-1 overflow-auto p-1">
      <el-tree
        v-if="treeData.length"
        ref="treeRef"
        class="panel-tree panel-tree--node"
        :data="treeData"
        node-key="_id"
        :default-expanded-keys="expandedKeys"
        :auto-expand-parent="false"
        highlight-current
        :expand-on-click-node="false"
        draggable
        :allow-drag="allowDrag"
        :allow-drop="allowDrop"
        @node-click="onNodeClick"
        @node-drop="onNodeDrop"
        @node-expand="onNodeExpand"
        @node-collapse="onNodeCollapse"
        @node-contextmenu="onContextMenu"
      >
        <template #default="{ data }">
          <input
            v-if="editingId === (data as UINode)._id"
            ref="renameInput"
            v-model="editingName"
            class="tree-rename w-full min-w-0 rounded border border-sky-600 bg-zinc-950 px-1 py-0 text-[13px] text-zinc-100 outline-none"
            @click.stop
            @dblclick.stop
            @mousedown.stop
            @keydown.enter.prevent="finishRename(true)"
            @keydown.esc.prevent.stop="finishRename(false)"
            @blur="finishRename(true)"
          />
          <span
            v-else
            class="tree-label truncate text-[13px]"
            :class="{
              'text-zinc-200': (data as UINode).active,
              'text-zinc-500 line-through': !(data as UINode).active,
              'is-multi-selected': multiSelected.has((data as UINode)._id),
            }"
            title="双击修改名称"
            @dblclick.stop="beginRename(data as UINode)"
          >
            {{ (data as UINode).name }}
          </span>
        </template>
      </el-tree>
      <p v-else class="px-3 py-4 text-xs text-zinc-500">
        暂无 UI 数据，请通过顶部按钮新建或导入 UI 界面
      </p>
    </div>

    <Teleport to="body">
      <div
        v-if="menu.visible"
        class="fixed z-50 min-w-32 rounded-md border border-zinc-700 bg-zinc-800 py-1 text-[13px] shadow-xl"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @click.stop
      >
        <button class="block w-full px-4 py-1.5 text-left hover:bg-zinc-700" @click="menuAddChild">
          新建子节点
        </button>
        <button
          class="block w-full px-4 py-1.5 text-left hover:bg-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-600"
          :disabled="!menuBatchCount"
          @click="menuDuplicate"
        >
          复制节点
          <span v-if="menuBatchCount > 1" class="text-zinc-500"> ({{ menuBatchCount }})</span>
        </button>
        <button
          class="block w-full px-4 py-1.5 text-left text-red-400 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-600"
          :disabled="!menuBatchCount"
          @click="menuRemove"
        >
          删除节点
          <span v-if="menuBatchCount > 1" class="text-zinc-500"> ({{ menuBatchCount }})</span>
        </button>
      </div>
    </Teleport>
  </section>
</template>
