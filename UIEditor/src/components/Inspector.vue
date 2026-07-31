<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useEditorStore } from '../stores/editor'
import { useProjectStore } from '../stores/project'
import PropField from './PropField.vue'

const editor = useEditorStore()
const project = useProjectStore()

const node = computed(() => editor.selectedNode)
const mountedComponents = computed(() => Object.keys(node.value?.components ?? {}))
const availableComponents = computed(() =>
  Object.keys(project.componentDefs).filter((t) => !node.value?.components[t]),
)

const activeNames = ref<string[]>([])
watch(
  () => [editor.selectedId, mountedComponents.value.join(',')],
  () => {
    activeNames.value = [...mountedComponents.value]
  },
  { immediate: true },
)

function onAddComponent(type: string) {
  if (node.value) editor.addComponent(node.value._id, type)
}

function onRemoveComponent(type: string) {
  if (node.value) editor.removeComponent(node.value._id, type)
}

async function onDeleteNode() {
  if (!node.value || editor.isRootSelected) return
  try {
    await ElMessageBox.confirm(`确定删除节点 "${node.value.name}" 及其全部子节点？`, '删除节点', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
    editor.removeNode(node.value._id)
  } catch {
    /* 用户取消 */
  }
}
</script>

<template>
  <div class="flex flex-col text-[13px]">
    <h3
      class="shrink-0 border-b border-zinc-800 px-3 py-1.5 text-xs font-semibold tracking-wider text-zinc-400 select-none"
    >
      属性检查器
    </h3>

    <p v-if="!node" class="px-3 py-6 text-center text-xs text-zinc-500">未选中任何节点</p>

    <template v-else>
      <!-- 基础属性（内置变换组件，不可删除） -->
      <div class="space-y-2 border-b border-zinc-800 p-3">
        <div class="flex items-center gap-2">
          <span class="w-14 shrink-0 text-zinc-400">name</span>
          <el-input v-model="node.name" size="small" @change="editor.commit()" />
        </div>
        <div class="flex items-center gap-2">
          <span class="w-14 shrink-0 text-zinc-400">active</span>
          <el-switch v-model="node.active" @change="editor.commit()" />
        </div>
        <div class="flex items-center gap-2">
          <span class="w-14 shrink-0 text-zinc-400">x / y</span>
          <el-input-number
            v-model="node.x"
            size="small"
            class="!w-1/2"
            controls-position="right"
            @change="editor.commit()"
          />
          <el-input-number
            v-model="node.y"
            size="small"
            class="!w-1/2"
            controls-position="right"
            @change="editor.commit()"
          />
        </div>
        <div class="flex items-center gap-2">
          <span class="w-14 shrink-0 text-zinc-400">w / h</span>
          <el-input-number
            v-model="node.width"
            size="small"
            class="!w-1/2"
            :min="0"
            controls-position="right"
            @change="editor.commit()"
          />
          <el-input-number
            v-model="node.height"
            size="small"
            class="!w-1/2"
            :min="0"
            controls-position="right"
            @change="editor.commit()"
          />
        </div>
        <div class="flex items-center gap-2">
          <span class="w-14 shrink-0 text-zinc-400">zIndex</span>
          <el-input-number
            v-model="node.zIndex"
            size="small"
            class="!w-full"
            controls-position="right"
            @change="editor.commit()"
          />
        </div>
        <el-button
          v-if="!editor.isRootSelected"
          type="danger"
          size="small"
          plain
          class="!mt-3 w-full"
          @click="onDeleteNode"
        >
          删除节点
        </el-button>
      </div>

      <!-- 组件管理 -->
      <div class="p-3">
        <el-dropdown
          class="mb-2 w-full"
          trigger="click"
          :disabled="!availableComponents.length"
          @command="onAddComponent"
        >
          <el-button size="small" type="primary" plain class="w-full">
            添加组件 ▾
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="type in availableComponents" :key="type" :command="type">
                {{ type }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>

        <el-collapse v-model="activeNames">
          <el-collapse-item v-for="type in mountedComponents" :key="type" :name="type">
            <template #title>
              <div class="flex w-full items-center justify-between pr-2">
                <span class="font-medium text-sky-300">{{ type }}</span>
                <el-button
                  size="small"
                  type="danger"
                  text
                  @click.stop="onRemoveComponent(type)"
                >
                  删除组件
                </el-button>
              </div>
            </template>

            <div class="space-y-2 pt-1">
              <template v-if="project.componentDefs[type]">
                <div
                  v-for="(propDef, propName) in project.componentDefs[type].properties"
                  :key="propName"
                  class="flex items-center gap-2"
                >
                  <span class="w-20 shrink-0 truncate text-zinc-400" :title="String(propName)">
                    {{ propName }}
                  </span>
                  <div class="min-w-0 flex-1">
                    <PropField
                      v-model="node.components[type][propName]"
                      :def="propDef"
                      :drop-target="type === 'SpriteComponent' && String(propName) === 'framePath'"
                      @commit="editor.commit()"
                    />
                  </div>
                </div>
              </template>
              <p v-else class="text-xs text-zinc-500">
                组件库中没有 "{{ type }}" 的定义，数据以只读方式保留。
              </p>
            </div>
          </el-collapse-item>
        </el-collapse>
      </div>
    </template>
  </div>
</template>

<style scoped>
:deep(.el-collapse) {
  --el-collapse-header-bg-color: transparent;
  --el-collapse-content-bg-color: transparent;
  border-color: #3f3f46;
}
:deep(.el-collapse-item__header) {
  height: 34px;
  border-color: #3f3f46;
}
:deep(.el-collapse-item__content) {
  padding-bottom: 12px;
}
</style>
