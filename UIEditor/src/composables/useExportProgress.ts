/**
 * 通用「导出 Prefab」进度状态：与具体引擎解耦，TopBar / 其它入口复用。
 */
import { computed, ref } from 'vue'
import {
  EXPORT_ENGINE_LABELS,
  exportProgressPercent,
  type ExportEngineId,
  type ExportProgressEvent,
} from '../utils/exportProgress'

export function useExportProgress() {
  const visible = ref(false)
  const engine = ref<ExportEngineId>('cocos')
  const phase = ref('')
  const message = ref('')
  const current = ref(0)
  const total = ref(1)

  const title = computed(() => {
    if (engine.value === 'psd') return '导入 PSD'
    const label = EXPORT_ENGINE_LABELS[engine.value] || String(engine.value)
    return `导出 ${label}`
  })

  const percent = computed(() =>
    exportProgressPercent({ current: current.value, total: total.value }),
  )

  function open(targetEngine: ExportEngineId, initialMessage?: string) {
    engine.value = targetEngine
    phase.value = 'prepare'
    message.value =
      initialMessage ?? (targetEngine === 'psd' ? '准备导入…' : '准备导出…')
    current.value = 0
    total.value = 1
    visible.value = true
  }

  function update(event: ExportProgressEvent) {
    engine.value = event.engine
    phase.value = event.phase
    message.value = event.message
    current.value = event.current
    total.value = Math.max(1, event.total)
    if (!visible.value) visible.value = true
  }

  function close() {
    visible.value = false
  }

  /**
   * 执行导出任务并展示进度。
   * @param openOnFirstProgress 默认 true：等首条进度事件再弹框（便于先选目录/确认覆盖）
   */
  async function runWithProgress<T>(
    targetEngine: ExportEngineId,
    task: (onProgress: (e: ExportProgressEvent) => void) => Promise<T>,
    options?: { openOnFirstProgress?: boolean },
  ): Promise<T> {
    const lazy = options?.openOnFirstProgress !== false
    if (!lazy) open(targetEngine)
    try {
      return await task((e) => {
        if (!visible.value) open(targetEngine, e.message)
        update(e)
      })
    } finally {
      close()
    }
  }

  return {
    visible,
    engine,
    phase,
    message,
    current,
    total,
    title,
    percent,
    open,
    update,
    close,
    runWithProgress,
  }
}
