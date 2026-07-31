<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useProjectStore } from '../stores/project'
import { useEditorStore } from '../stores/editor'
import { createDefaultUIData, serializeForDisk } from '../utils/node'
import ComponentLibDialog from './ComponentLibDialog.vue'

const project = useProjectStore()
const editor = useEditorStore()
const libDialogVisible = ref(false)

const saveLabel = computed(() => {
  switch (editor.saveState) {
    case 'pending':
    case 'saving':
      return '保存中…'
    case 'saved':
      return '已保存'
    case 'error':
      return '保存失败'
    default:
      return ''
  }
})

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

async function onNewProject() {
  try {
    const main = await project.newProject()
    if (main) {
      await editor.loadUIFile(main.handle, main.path)
      ElMessage.success(`项目 "${project.projectName}" 初始化完成`)
    }
  } catch (err) {
    if (!isAbort(err)) ElMessage.error(`新建项目失败：${String(err)}`)
  }
}

async function onImportProject() {
  try {
    const main = await project.importProject()
    if (main) {
      // 空文件夹：已自动初始化基础项目结构
      await editor.loadUIFile(main.handle, main.path)
      ElMessage.success(`文件夹为空，已自动初始化项目 "${project.projectName}" 并创建 main.json`)
    } else {
      ElMessage.success(`已挂载项目 "${project.projectName}"`)
    }
  } catch (err) {
    if (!isAbort(err)) ElMessage.error(`导入项目失败：${String(err)}`)
  }
}

async function onNewUIFile() {
  if (!project.dirHandle) {
    ElMessage.warning('请先新建或导入项目')
    return
  }
  try {
    const { value } = await ElMessageBox.prompt('输入新 UI 界面名称', '新建UI界面', {
      inputPattern: /^[\w\-\u4e00-\u9fa5]+$/,
      inputErrorMessage: '名称只能包含字母、数字、下划线、中划线或中文',
      inputValue: 'newUI',
      confirmButtonText: '创建',
      cancelButtonText: '取消',
    })
    const path = `${value}.json`
    const handle = await project.createProjectFile(path, serializeForDisk(createDefaultUIData()))
    await editor.loadUIFile(handle, path)
    ElMessage.success(`已创建 ${path}`)
  } catch (err) {
    if (err !== 'cancel' && !isAbort(err)) ElMessage.error(`新建UI界面失败：${String(err)}`)
  }
}

async function onImportUIFile() {
  try {
    const ok = await editor.importUIFile()
    if (!ok) ElMessage.error('文件不是合法的 UI 节点 JSON')
  } catch (err) {
    if (!isAbort(err)) ElMessage.error(`导入失败：${String(err)}`)
  }
}

async function onExportUIFile() {
  if (!editor.currentUIData) {
    ElMessage.warning('当前没有打开的 UI 界面')
    return
  }
  try {
    await editor.exportUIFile()
    ElMessage.success('导出成功')
  } catch (err) {
    if (!isAbort(err)) ElMessage.error(`导出失败：${String(err)}`)
  }
}
</script>

<template>
  <header
    class="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 select-none"
  >
    <span class="mr-2 text-sm font-bold tracking-wide text-sky-400">UI Editor</span>

    <el-button-group size="small">
      <el-button @click="onNewProject">新建项目</el-button>
      <el-button @click="onImportProject">导入项目</el-button>
    </el-button-group>

    <el-button-group size="small">
      <el-button :disabled="!project.dirHandle" @click="onNewUIFile">新建UI界面</el-button>
      <el-button @click="onImportUIFile">导入UI界面</el-button>
      <el-button :disabled="!editor.currentUIData" @click="onExportUIFile">导出UI界面</el-button>
    </el-button-group>

    <el-button size="small" @click="libDialogVisible = true">编辑组件库</el-button>

    <el-button-group size="small" class="ml-2">
      <el-button :disabled="!editor.canUndo" title="Ctrl+Z" @click="editor.undo()">撤销</el-button>
      <el-button :disabled="!editor.canRedo" title="Ctrl+Y" @click="editor.redo()">重做</el-button>
    </el-button-group>

    <div class="ml-auto flex items-center gap-3 text-xs text-zinc-500">
      <span v-if="project.projectName" class="text-zinc-400">
        项目：{{ project.projectName }}
      </span>
      <span v-if="editor.currentFilePath" class="text-zinc-400">
        {{ editor.currentFilePath }}
      </span>
      <span
        v-if="saveLabel"
        :class="editor.saveState === 'error' ? 'text-red-400' : 'text-emerald-500'"
      >
        {{ saveLabel }}
      </span>
    </div>

    <ComponentLibDialog v-model="libDialogVisible" />
  </header>
</template>
