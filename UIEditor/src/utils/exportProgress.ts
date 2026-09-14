/**
 * 引擎 Prefab 导出进度（与具体引擎 / UI 框架解耦）。
 * Cocos / 后续 Unity 等导出共用同一事件形状，进度框只消费本类型。
 */

/** 导出目标引擎标识；新增引擎时扩展联合类型或直接传自定义字符串 */
export type ExportEngineId = 'cocos' | (string & {})

export interface ExportProgressEvent {
  /** 目标引擎，如 cocos；进度框标题可据此映射 */
  engine: ExportEngineId
  /** 阶段 key：prepare | read-images | write-images | write-prefab | write-script | done */
  phase: string
  /** 面向用户的阶段说明 */
  message: string
  /** 已完成步数（从 0 递增） */
  current: number
  /** 总步数（>= 1） */
  total: number
}

export type OnExportProgress = (event: ExportProgressEvent) => void

export function exportProgressPercent(event: Pick<ExportProgressEvent, 'current' | 'total'>): number {
  if (event.total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((event.current / event.total) * 100)))
}

/** 让出主线程，保证进度框能刷新 */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** 线性步进进度报告器 */
export function createExportProgressReporter(
  engine: ExportEngineId,
  total: number,
  onProgress?: OnExportProgress,
): (phase: string, message: string) => Promise<void> {
  const safeTotal = Math.max(1, total)
  let current = 0
  return async (phase: string, message: string) => {
    current = Math.min(current + 1, safeTotal)
    onProgress?.({
      engine,
      phase,
      message,
      current,
      total: safeTotal,
    })
    await yieldToUi()
  }
}

/** 常见引擎展示名（进度框标题用） */
export const EXPORT_ENGINE_LABELS: Record<string, string> = {
  cocos: 'Cocos Creator Prefab',
  psd: 'PSD',
}
