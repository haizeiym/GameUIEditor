<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useExportProgress } from '../composables/useExportProgress'
import { useProjectStore } from '../stores/project'
import { useEditorStore } from '../stores/editor'
import { createDefaultUIData, serializeForDisk } from '../utils/node'
import {
  type RecentIoKind,
  type RecentIoMeta,
  ensureHandlePermission,
  getRecentHandle,
  latestRecentHandle,
  listRecentIo,
  rememberRecentIo,
  removeRecentIo,
} from '../utils/recentIoPaths'
import ComponentLibDialog from './ComponentLibDialog.vue'
import ExportProgressDialog from './ExportProgressDialog.vue'

const project = useProjectStore()
const editor = useEditorStore()
const {
  visible: exportProgressVisible,
  title: exportProgressTitle,
  message: exportProgressMessage,
  percent: exportProgressPercent,
  current: exportProgressCurrent,
  total: exportProgressTotal,
  runWithProgress,
} = useExportProgress()
const libDialogVisible = ref(false)
const resolutionDialogVisible = ref(false)
const draftWidth = ref(1366)
const draftHeight = ref(768)

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

const recents = ref<Record<RecentIoKind, RecentIoMeta[]>>({
  'import-psd': [],
  'export-prefab': [],
  'export-psd-template': [],
})

function refreshRecents() {
  recents.value = {
    'import-psd': listRecentIo('import-psd'),
    'export-prefab': listRecentIo('export-prefab'),
    'export-psd-template': listRecentIo('export-psd-template'),
  }
}

onMounted(refreshRecents)

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
    // Root 尺寸 = 当前设计分辨率（横屏或竖屏）
    const handle = await project.createProjectFile(
      path,
      serializeForDisk(createDefaultUIData(editor.canvasWidth, editor.canvasHeight)),
    )
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

function onToggleOrientation() {
  editor.toggleOrientation()
  ElMessage.success(
    `已切换为${editor.orientation === 'landscape' ? '横屏' : '竖屏'} ${editor.resolutionLabel}`,
  )
}

function openResolutionDialog() {
  draftWidth.value = editor.canvasWidth
  draftHeight.value = editor.canvasHeight
  resolutionDialogVisible.value = true
}

function onConfirmResolution() {
  editor.setResolution(draftWidth.value, draftHeight.value)
  resolutionDialogVisible.value = false
  ElMessage.success(`分辨率已设为 ${editor.resolutionLabel}`)
}

async function resolveRecentHandle(
  id: string,
  expect: 'file' | 'directory',
  mode: 'read' | 'readwrite',
): Promise<FileSystemHandle | null> {
  const handle = await getRecentHandle(id)
  if (!handle || handle.kind !== expect) {
    await removeRecentIo(id)
    refreshRecents()
    ElMessage.warning('最近路径已失效，请重新选择')
    return null
  }
  if (!(await ensureHandlePermission(handle, mode))) {
    await removeRecentIo(id)
    refreshRecents()
    ElMessage.warning('无法访问该路径，请重新选择')
    return null
  }
  return handle
}

async function importPsdFromHandle(handle: FileSystemFileHandle) {
  const file = await handle.getFile()
  const loading = ElMessage({
    message: `正在导入 PSD「${file.name}」并解析图层…`,
    type: 'info',
    duration: 0,
    showClose: false,
  })
  try {
    const result = await project.importPsd(file, {
      rootWidth: editor.canvasWidth,
      rootHeight: editor.canvasHeight,
    })
    loading.close()
    await editor.loadUIFile(result.handle, result.path)
    editor.setResolution(result.rootWidth, result.rootHeight)
    await rememberRecentIo('import-psd', handle)
    refreshRecents()
    ElMessage.success(
      `PSD 导入完成：${result.path}（${result.layerCount} 个图层，PSD ${result.documentWidth}×${result.documentHeight}，Root ${result.rootWidth}×${result.rootHeight}）`,
    )
  } catch (err) {
    loading.close()
    throw err
  }
}

async function onImportPsd() {
  if (!project.dirHandle) {
    ElMessage.warning('请先新建或导入项目')
    return
  }
  try {
    const startIn = await latestRecentHandle('import-psd')
    const [handle] = await window.showOpenFilePicker({
      types: [
        {
          description: 'Photoshop PSD',
          accept: { 'image/vnd.adobe.photoshop': ['.psd'], 'application/octet-stream': ['.psd'] },
        },
      ],
      excludeAcceptAllOption: false,
      id: 'ui-editor-import-psd',
      startIn,
    })
    await importPsdFromHandle(handle)
  } catch (err) {
    if (!isAbort(err)) ElMessage.error(`导入 PSD 失败：${String(err)}`)
  }
}

async function onImportPsdRecent(id: string) {
  if (!project.dirHandle) {
    ElMessage.warning('请先新建或导入项目')
    return
  }
  const handle = await resolveRecentHandle(id, 'file', 'read')
  if (!handle) {
    await onImportPsd()
    return
  }
  try {
    await importPsdFromHandle(handle as FileSystemFileHandle)
  } catch (err) {
    if (!isAbort(err)) ElMessage.error(`导入 PSD 失败：${String(err)}`)
  }
}

async function onExportPsdTemplate() {
  if (!editor.currentUIData) {
    ElMessage.warning('当前没有打开的 UI 界面')
    return
  }
  try {
    await editor.exportPsdTemplate()
    refreshRecents()
    ElMessage.success('PSD 模版导出成功')
  } catch (err) {
    if (!isAbort(err)) ElMessage.error(`导出 PSD 模版失败：${String(err)}`)
  }
}

async function onExportPsdTemplateRecent(id: string) {
  if (!editor.currentUIData) {
    ElMessage.warning('当前没有打开的 UI 界面')
    return
  }
  const handle = await resolveRecentHandle(id, 'file', 'readwrite')
  if (!handle) {
    await onExportPsdTemplate()
    return
  }
  try {
    await editor.exportPsdTemplate(handle as FileSystemFileHandle)
    refreshRecents()
    ElMessage.success('PSD 模版导出成功')
  } catch (err) {
    if (!isAbort(err)) ElMessage.error(`导出 PSD 模版失败：${String(err)}`)
  }
}

async function runExportCocosPrefab(existingDir?: FileSystemDirectoryHandle) {
  const result = await runWithProgress('cocos', async (onProgress) => {
    return editor.exportCocosCreatorPrefab(async (baseName) => {
      try {
        await ElMessageBox.confirm(
          `导出目录下已存在「${baseName}/」，是否覆盖？`,
          '覆盖确认',
          { confirmButtonText: '覆盖', cancelButtonText: '取消', type: 'warning' },
        )
        return true
      } catch {
        return false
      }
    }, onProgress, existingDir)
  })
  if (!result) {
    ElMessage.info('已取消导出')
    return
  }
  refreshRecents()
  ElMessage.success(`Prefab 导出完成：${result.prefabPath}（${result.imageCount} 张图片）`)
}

async function onExportCocosPrefab() {
  if (!editor.currentUIData) {
    ElMessage.warning('当前没有打开的 UI 界面')
    return
  }
  if (!project.dirHandle) {
    ElMessage.warning('请先新建或导入项目（导出需读取项目内图片）')
    return
  }
  try {
    await runExportCocosPrefab()
  } catch (err) {
    if (!isAbort(err)) ElMessage.error(`导出 Prefab 失败：${String(err)}`)
  }
}

async function onExportCocosPrefabRecent(id: string) {
  if (!editor.currentUIData) {
    ElMessage.warning('当前没有打开的 UI 界面')
    return
  }
  if (!project.dirHandle) {
    ElMessage.warning('请先新建或导入项目（导出需读取项目内图片）')
    return
  }
  const handle = await resolveRecentHandle(id, 'directory', 'readwrite')
  if (!handle) {
    await onExportCocosPrefab()
    return
  }
  try {
    await runExportCocosPrefab(handle as FileSystemDirectoryHandle)
  } catch (err) {
    if (!isAbort(err)) ElMessage.error(`导出 Prefab 失败：${String(err)}`)
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
      <el-button
        :disabled="!editor.currentUIData"
        :title="`当前：${editor.orientation === 'landscape' ? '横屏' : '竖屏'}`"
        @click="onToggleOrientation"
      >
        切换横竖屏
      </el-button>
      <el-button :title="editor.resolutionLabel" @click="openResolutionDialog">
        设置分辨率
      </el-button>
      <el-dropdown
        split-button
        size="small"
        trigger="click"
        :disabled="!project.dirHandle"
        title="解析图层为图片并生成 UI JSON"
        @click="onImportPsd"
        @command="onImportPsdRecent"
      >
        导入PSD
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="item in recents['import-psd']"
              :key="item.id"
              :command="item.id"
            >
              {{ item.name }}
            </el-dropdown-item>
            <el-dropdown-item v-if="!recents['import-psd'].length" disabled>
              暂无最近路径
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-dropdown
        split-button
        size="small"
        trigger="click"
        :disabled="!editor.currentUIData"
        title="按当前节点树导出 Photoshop 图层模版（名称/结构/显隐；图片层为占位图）"
        @click="onExportPsdTemplate"
        @command="onExportPsdTemplateRecent"
      >
        导出PSD模版
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="item in recents['export-psd-template']"
              :key="item.id"
              :command="item.id"
            >
              {{ item.name }}
            </el-dropdown-item>
            <el-dropdown-item v-if="!recents['export-psd-template'].length" disabled>
              暂无最近路径
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-dropdown
        split-button
        size="small"
        trigger="click"
        :disabled="!editor.currentUIData || !project.dirHandle"
        title="导出为 Cocos Creator 3.8 Prefab（含图片与 .meta）"
        @click="onExportCocosPrefab"
        @command="onExportCocosPrefabRecent"
      >
        导出Cocos Prefab
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="item in recents['export-prefab']"
              :key="item.id"
              :command="item.id"
            >
              {{ item.name }}
            </el-dropdown-item>
            <el-dropdown-item v-if="!recents['export-prefab'].length" disabled>
              暂无最近路径
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
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

    <ExportProgressDialog
      v-model="exportProgressVisible"
      :title="exportProgressTitle"
      :message="exportProgressMessage"
      :percent="exportProgressPercent"
      :current="exportProgressCurrent"
      :total="exportProgressTotal"
    />

    <el-dialog v-model="resolutionDialogVisible" title="设置分辨率" width="360px">
      <div class="flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <span class="w-12 text-zinc-400">宽</span>
          <el-input-number v-model="draftWidth" :min="1" :max="8192" controls-position="right" class="w-full!" />
        </div>
        <div class="flex items-center gap-2">
          <span class="w-12 text-zinc-400">高</span>
          <el-input-number v-model="draftHeight" :min="1" :max="8192" controls-position="right" class="w-full!" />
        </div>
        <p class="text-xs text-zinc-500">默认 1366×768（横屏）。修改后同步到根节点宽高，画布中心仍为坐标原点 (0,0)。</p>
      </div>
      <template #footer>
        <el-button size="small" @click="resolutionDialogVisible = false">取消</el-button>
        <el-button size="small" type="primary" @click="onConfirmResolution">确定</el-button>
      </template>
    </el-dialog>
  </header>
</template>
