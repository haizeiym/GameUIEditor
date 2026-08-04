<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { ElTree } from 'element-plus'
import type Node from 'element-plus/es/components/tree/src/model/node'
import type { UINode } from '../types'
import { useEditorStore } from '../stores/editor'
import { collectNodeIds, pruneExpandedKeys } from '../utils/nodeTreeExpand'

const editor = useEditorStore()
const treeRef = ref<InstanceType<typeof ElTree>>()

const treeData = computed<UINode[]>(() => (editor.currentUIData ? [editor.currentUIData] : []))

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

// store 选中态 → 树高亮；第二参 false = 不自动展开父链
watch(
  () => [editor.selectedId, editor.currentUIData] as const,
  async () => {
    await nextTick()
    if (editor.selectedId) treeRef.value?.setCurrentKey(editor.selectedId, false)
  },
  { immediate: true },
)

function onNodeClick(data: UINode) {
  editor.selectedId = data._id
}

// ---------- 拖拽约束：根节点不可拖动，也不可有同级 ----------

function allowDrag(node: Node): boolean {
  return (node.data as UINode)._id !== editor.rootId
}

function allowDrop(_dragging: Node, dropNode: Node, type: 'prev' | 'inner' | 'next'): boolean {
  if ((dropNode.data as UINode)._id === editor.rootId) return type === 'inner'
  return true
}

function onNodeDrop() {
  editor.afterTreeDrop()
}

// ---------- 右键菜单 ----------

const menu = reactive({ visible: false, x: 0, y: 0, nodeId: '' })
const menuIsRoot = computed(() => menu.nodeId === editor.rootId)

function onContextMenu(event: MouseEvent, data: UINode) {
  event.preventDefault()
  editor.selectedId = data._id
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
  if (!menuIsRoot.value) editor.duplicateNode(menu.nodeId)
  closeMenu()
}

function menuRemove() {
  if (!menuIsRoot.value) editor.removeNode(menu.nodeId)
  closeMenu()
}

onMounted(() => window.addEventListener('click', closeMenu))
onBeforeUnmount(() => window.removeEventListener('click', closeMenu))
</script>

<template>
  <section class="flex flex-col">
    <h3 class="shrink-0 border-b border-zinc-800 px-3 py-1.5 text-xs font-semibold tracking-wider text-zinc-400 select-none">
      节点树
    </h3>
    <div class="min-h-0 flex-1 overflow-auto p-1">
      <el-tree
        v-if="treeData.length"
        ref="treeRef"
        class="panel-tree"
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
          <span
            class="truncate text-[13px]"
            :class="(data as UINode).active ? 'text-zinc-200' : 'text-zinc-500 line-through'"
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
          :disabled="menuIsRoot"
          @click="menuDuplicate"
        >
          复制节点
        </button>
        <button
          class="block w-full px-4 py-1.5 text-left text-red-400 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-600"
          :disabled="menuIsRoot"
          @click="menuRemove"
        >
          删除节点
        </button>
      </div>
    </Teleport>
  </section>
</template>
