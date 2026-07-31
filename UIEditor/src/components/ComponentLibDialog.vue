<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useProjectStore } from '../stores/project'

const visible = defineModel<boolean>({ required: true })
const project = useProjectStore()

const text = ref('')
const errorMsg = ref('')
const saving = ref(false)

watch(visible, (v) => {
  if (v) {
    text.value = project.componentDefsText
    errorMsg.value = ''
  }
})

async function onSave() {
  saving.value = true
  errorMsg.value = ''
  try {
    await project.saveComponentDefs(text.value)
    ElMessage.success(
      project.dirHandle ? '组件库已保存并写回 components.json' : '组件库已更新（未挂载项目，仅内存生效）',
    )
    visible.value = false
  } catch (err) {
    errorMsg.value = err instanceof SyntaxError ? `JSON 语法错误：${err.message}` : String(err)
  } finally {
    saving.value = false
  }
}

function onFormat() {
  try {
    text.value = JSON.stringify(JSON.parse(text.value), null, 2)
    errorMsg.value = ''
  } catch (err) {
    errorMsg.value = err instanceof Error ? `JSON 语法错误：${err.message}` : String(err)
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="编辑组件库 (components.json)" width="640px" top="8vh">
    <textarea
      v-model="text"
      spellcheck="false"
      class="h-96 w-full resize-none rounded border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-200 outline-none focus:border-sky-600"
    ></textarea>
    <p v-if="errorMsg" class="mt-2 text-xs text-red-400">{{ errorMsg }}</p>
    <template #footer>
      <el-button size="small" @click="onFormat">格式化</el-button>
      <el-button size="small" @click="visible = false">取消</el-button>
      <el-button size="small" type="primary" :loading="saving" @click="onSave">保存</el-button>
    </template>
  </el-dialog>
</template>
