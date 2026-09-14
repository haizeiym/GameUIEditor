/**
 * 顶栏按钮显隐与顺序（仅网页，localStorage）。
 */

export const TOPBAR_ACTION_IDS = [
  'new-project',
  'import-project',
  'new-ui',
  'import-ui',
  'export-ui',
  'toggle-orientation',
  'set-resolution',
  'import-psd',
  'export-psd-template',
  'export-prefab',
  'edit-components',
  'undo',
  'redo',
] as const

export type TopbarActionId = (typeof TOPBAR_ACTION_IDS)[number]

export interface TopbarActionState {
  id: TopbarActionId
  visible: boolean
}

export const TOPBAR_ACTION_LABELS: Record<TopbarActionId, string> = {
  'new-project': '新建项目',
  'import-project': '导入项目',
  'new-ui': '新建UI界面',
  'import-ui': '导入UI界面',
  'export-ui': '导出UI界面',
  'toggle-orientation': '切换横竖屏',
  'set-resolution': '设置分辨率',
  'import-psd': '导入PSD',
  'export-psd-template': '导出PSD模版',
  'export-prefab': '导出Cocos Prefab',
  'edit-components': '编辑组件库',
  undo: '撤销',
  redo: '重做',
}

const LS_KEY = 'uieditor.topbar-layout'
const ID_SET = new Set<string>(TOPBAR_ACTION_IDS)

export function defaultTopbarLayout(): TopbarActionState[] {
  return TOPBAR_ACTION_IDS.map((id) => ({ id, visible: true }))
}

function isActionId(id: string): id is TopbarActionId {
  return ID_SET.has(id)
}

export function loadTopbarLayout(): TopbarActionState[] {
  const fallback = defaultTopbarLayout()
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return fallback
    const seen = new Set<TopbarActionId>()
    const out: TopbarActionState[] = []
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue
      const rec = row as Record<string, unknown>
      if (typeof rec.id !== 'string' || !isActionId(rec.id) || seen.has(rec.id)) continue
      seen.add(rec.id)
      out.push({ id: rec.id, visible: rec.visible !== false })
    }
    for (const id of TOPBAR_ACTION_IDS) {
      if (!seen.has(id)) out.push({ id, visible: true })
    }
    return out.length ? out : fallback
  } catch {
    return fallback
  }
}

export function saveTopbarLayout(items: TopbarActionState[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(items))
  } catch (err) {
    console.warn('[topbarLayout] 无法写入 localStorage', err)
  }
}
