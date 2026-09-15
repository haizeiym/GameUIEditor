<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useEditorStore } from '../stores/editor'
import { useProjectStore } from '../stores/project'
import { canAddComponent, collectNodeRefOptions } from '../utils/node'
import {
  markdownPathFromDrop,
  resolveScriptMetaUuid,
  scriptPathFromDrop,
  toastScriptMetaError,
} from '../utils/scriptMeta'
import { isMarkdownTemplatePath, isRemoteTemplateUrl } from '../utils/prefabTsTemplate'
import {
  hasScriptBindProps,
  listRecentScriptBinds,
  rememberScriptBind,
} from '../utils/recentScriptBinds'
import {
  listRecentTemplatePaths,
  listRecentTemplateTypes,
  rememberTemplatePath,
  rememberTemplateType,
} from '../utils/recentTemplateTypes'
import { rememberTemplateMd } from '../utils/templateMdCache'
import PropField from './PropField.vue'

const editor = useEditorStore()
const project = useProjectStore()

const node = computed(() => editor.selectedNode)
const mountedComponents = computed(() => Object.keys(node.value?.components ?? {}))
const nodeRefOptions = computed(() => (node.value ? collectNodeRefOptions(node.value) : []))
/** 同名不可重复；相同 componentType 也不可重复 */
const availableComponents = computed(() => {
  if (!node.value) return []
  return Object.keys(project.componentDefs).filter((t) =>
    canAddComponent(node.value!, t, project.componentDefs, editor.isRootSelected),
  )
})

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

function dropTargetFor(type: string, propName: string): 'image' | 'script' | 'markdown' | false {
  if (type === 'SpriteComponent' && propName === 'framePath') return 'image'
  if (propName === 'scriptPath') return 'script'
  if (propName === 'templatePath') return 'markdown'
  return false
}

/** 校验脚本路径，成功则写入 scriptPath + scriptUuid */
async function applyScriptPath(type: string, rawPath: string) {
  if (!node.value) return
  const comp = node.value.components[type]
  if (!comp) return
  const prevPath = typeof comp.scriptPath === 'string' ? comp.scriptPath : ''
  const result = await resolveScriptMetaUuid(rawPath, project.dirHandle)
  if (!result.ok || !result.uuid) {
    toastScriptMetaError(result.error || '脚本路径无效')
    comp.scriptPath = prevPath
    return
  }
  comp.scriptPath = result.scriptPath
  comp.scriptUuid = result.uuid
  rememberScriptBind(type, result.scriptPath, result.uuid)
  ElMessage.success(`已从 .meta 读取 UUID：${result.uuid}`)
  editor.commit()
}

async function onScriptPathCommit(type: string) {
  if (!node.value) return
  const comp = node.value.components[type]
  if (!comp) return
  const path = typeof comp.scriptPath === 'string' ? comp.scriptPath.trim() : ''
  if (!path) {
    comp.scriptUuid = ''
    editor.commit()
    return
  }
  await applyScriptPath(type, path)
}

async function applyTemplatePath(type: string, rawPath: string, text?: string) {
  const trimmed = rawPath.trim()
  const md = isRemoteTemplateUrl(trimmed) ? trimmed : trimmed.replace(/\\/g, '/')
  if (!isMarkdownTemplatePath(md)) {
    ElMessage.error('请填入 .md 路径、本机文件或 https://…/*.md')
    return
  }
  if (!node.value) return
  const comp = node.value.components[type]
  if (!comp) return
  if (text?.trim() && !isRemoteTemplateUrl(md)) rememberTemplateMd(md, text)
  comp.templatePath = md
  rememberTemplatePath(md)
  editor.commit()
  ElMessage.success(`已设置模板路径：${md}`)
}

async function onTemplatePathDrop(type: string, e: DragEvent) {
  e.preventDefault()
  const dropped = await markdownPathFromDrop(e)
  if (dropped.ok) {
    await applyTemplatePath(type, dropped.path, dropped.text)
    return
  }
  if (dropped.fileName) {
    try {
      const { value } = await ElMessageBox.prompt(
        dropped.error,
        '模板路径',
        {
          confirmButtonText: '确定',
          cancelButtonText: '取消',
          inputPlaceholder: `/Users/.../${dropped.fileName}`,
          inputPattern: /.+\.md$/i,
          inputErrorMessage: '须为 .md 文件路径',
        },
      )
      await applyTemplatePath(type, String(value || ''), dropped.text)
    } catch {
      /* 用户取消 */
    }
    return
  }
  ElMessage.error(dropped.error || '请拖入 .md 模板文件')
}

async function onFieldDrop(type: string, propName: string, e: DragEvent) {
  if (propName === 'templatePath') {
    await onTemplatePathDrop(type, e)
    return
  }
  await onScriptDrop(type, e)
}

async function onScriptDrop(type: string, e: DragEvent) {
  e.preventDefault()
  const dropped = await scriptPathFromDrop(e)
  if (!dropped.ok) {
    toastScriptMetaError(dropped.error || '拖入无效')
    return
  }
  // 拖放阶段已解析出 uuid（如授权目录读 .meta）时直接写入，避免重复弹窗
  if (dropped.uuid && node.value?.components[type]) {
    const comp = node.value.components[type]!
    comp.scriptPath = dropped.scriptPath
    comp.scriptUuid = dropped.uuid
    rememberScriptBind(type, dropped.scriptPath, dropped.uuid)
    ElMessage.success(`已从 .meta 读取 UUID：${dropped.uuid}`)
    editor.commit()
    return
  }
  await applyScriptPath(type, dropped.scriptPath)
}

function recentMenu(type: string, propName: string): { command: string; label: string }[] {
  if (propName === 'scriptPath') {
    if (!hasScriptBindProps(project.componentDefs[type])) return []
    return listRecentScriptBinds(type).map((item) => ({
      command: item.scriptPath,
      label: item.scriptPath.split(/[/\\]/).pop() || item.scriptPath,
    }))
  }
  if (propName === 'templateType') {
    return listRecentTemplateTypes().map((item) => ({ command: item, label: item }))
  }
  if (propName === 'templatePath') {
    return listRecentTemplatePaths().map((item) => ({
      command: item,
      label: item.split(/[/\\]/).pop() || item,
    }))
  }
  return []
}

function onRecentCommand(type: string, propName: string, command: string) {
  if (propName === 'scriptPath') {
    onPickRecentScript(type, command)
    return
  }
  if (propName === 'templateType') {
    if (!node.value) return
    const comp = node.value.components[type]
    if (!comp) return
    comp.templateType = command
    rememberTemplateType(command)
    editor.commit()
    return
  }
  if (propName === 'templatePath') {
    if (!node.value) return
    const comp = node.value.components[type]
    if (!comp) return
    comp.templatePath = command
    rememberTemplatePath(command)
    editor.commit()
  }
}

function onPickRecentScript(type: string, path: string) {
  if (!node.value) return
  const comp = node.value.components[type]
  if (!comp) return
  const hit = listRecentScriptBinds(type).find((row) => row.scriptPath === path)
  if (!hit) return
  comp.scriptPath = hit.scriptPath
  comp.scriptUuid = hit.scriptUuid
  rememberScriptBind(type, hit.scriptPath, hit.scriptUuid)
  editor.commit()
}

function onPropCommit(type: string, propName: string) {
  if (propName === 'scriptPath') {
    void onScriptPathCommit(type)
    return
  }
  if (propName === 'templateType' && node.value) {
    const raw = node.value.components[type]?.templateType
    if (typeof raw === 'string') rememberTemplateType(raw)
  }
  if (propName === 'templatePath' && node.value) {
    const raw = node.value.components[type]?.templatePath
    if (typeof raw === 'string' && raw.trim()) rememberTemplatePath(raw)
  }
  editor.commit()
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
            class="w-1/2!"
            controls-position="right"
            :disabled="editor.isRootSelected"
            @change="editor.commit()"
          />
          <el-input-number
            v-model="node.y"
            size="small"
            class="w-1/2!"
            controls-position="right"
            :disabled="editor.isRootSelected"
            @change="editor.commit()"
          />
        </div>
        <div class="flex items-center gap-2">
          <span class="w-14 shrink-0 text-zinc-400">w / h</span>
          <el-input-number
            v-model="node.width"
            size="small"
            class="w-1/2!"
            :min="1"
            controls-position="right"
            :disabled="editor.isRootSelected"
            :title="editor.isRootSelected ? 'Root 尺寸跟随设计分辨率（横竖屏切换 / 设置分辨率）' : undefined"
            @change="editor.commit()"
          />
          <el-input-number
            v-model="node.height"
            size="small"
            class="w-1/2!"
            :min="1"
            controls-position="right"
            :disabled="editor.isRootSelected"
            :title="editor.isRootSelected ? 'Root 尺寸跟随设计分辨率（横竖屏切换 / 设置分辨率）' : undefined"
            @change="editor.commit()"
          />
        </div>
        <p
          v-if="editor.isRootSelected"
          class="text-[11px] leading-snug text-zinc-500"
        >
          Root 尺寸 = 设计分辨率（{{ editor.resolutionLabel }}，{{
            editor.orientation === 'landscape' ? '横屏' : '竖屏'
          }}），请用顶部【设置分辨率】/【切换横竖屏】修改。
        </p>
        <div class="flex items-center gap-2">
          <span class="w-14 shrink-0 text-zinc-400">zIndex</span>
          <el-input-number
            v-model="node.zIndex"
            size="small"
            class="w-full!"
            controls-position="right"
            @change="editor.commit()"
          />
        </div>
        <el-button
          v-if="!editor.isRootSelected"
          type="danger"
          size="small"
          plain
          class="mt-3 w-full!"
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
                  <span
                    class="w-24 shrink-0 truncate text-zinc-400"
                    :title="propDef.displayName ? `${propDef.displayName} (${propName})` : String(propName)"
                  >
                    {{ propDef.displayName || propName }}
                  </span>
                  <div class="flex min-w-0 flex-1 items-stretch gap-1">
                    <div class="min-w-0 flex-1">
                      <PropField
                        v-model="node.components[type][propName]"
                        :def="propDef"
                        :drop-target="dropTargetFor(type, String(propName))"
                        :node-options="propDef.type === 'node' ? nodeRefOptions : undefined"
                        @script-drop="onFieldDrop(type, String(propName), $event)"
                        @commit="onPropCommit(type, String(propName))"
                      />
                    </div>
                    <el-dropdown
                      v-if="recentMenu(type, String(propName)).length"
                      trigger="click"
                      @command="onRecentCommand(type, String(propName), $event)"
                    >
                      <el-button size="small" title="最近记录">最近</el-button>
                      <template #dropdown>
                        <el-dropdown-menu>
                          <el-dropdown-item
                            v-for="item in recentMenu(type, String(propName))"
                            :key="item.command"
                            :command="item.command"
                            :title="item.command"
                          >
                            {{ item.label }}
                          </el-dropdown-item>
                        </el-dropdown-menu>
                      </template>
                    </el-dropdown>
                  </div>
                </div>
                <p v-if="type === 'TemplateComponent'" class="text-[11px] leading-snug text-zinc-500">
                  仅 Root 生效。无路径：空/「1」→ codePreview/cocosPrefab.md 的 ### 1；「list_item」→ list.md 的 ### item。有 templatePath 时用该 .md（本机 / 项目相对 / https://…/*.md），templateType 原样对应标题（「xxx_aaa」→ ### xxx_aaa）。远程地址导出前下载并走进度框。导出时 FileName 换成包名。
                </p>
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
