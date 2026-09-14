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

export const TOPBAR_LAYOUT_LS_KEY = 'uieditor.topbar-layout'
const ID_SET = new Set<string>(TOPBAR_ACTION_IDS)

export function defaultTopbarLayout(): TopbarActionState[] {
  return TOPBAR_ACTION_IDS.map((id) => ({ id, visible: true }))
}

function isActionId(id: string): id is TopbarActionId {
  return ID_SET.has(id)
}

function canUseLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

function normalizeLayout(rows: unknown): TopbarActionState[] | null {
  if (!Array.isArray(rows)) return null
  const seen = new Set<TopbarActionId>()
  const out: TopbarActionState[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const rec = row as Record<string, unknown>
    if (typeof rec.id !== 'string' || !isActionId(rec.id) || seen.has(rec.id)) continue
    seen.add(rec.id)
    out.push({ id: rec.id, visible: rec.visible !== false })
  }
  for (const id of TOPBAR_ACTION_IDS) {
    if (!seen.has(id)) out.push({ id, visible: true })
  }
  return out.length ? out : null
}

export function loadTopbarLayout(): TopbarActionState[] {
  const fallback = defaultTopbarLayout()
  if (!canUseLocalStorage()) return fallback
  try {
    const raw = localStorage.getItem(TOPBAR_LAYOUT_LS_KEY)
    if (!raw) return fallback
    const parsed = normalizeLayout(JSON.parse(raw) as unknown)
    return parsed ?? fallback
  } catch (err) {
    console.warn('[topbarLayout] 无法读取 localStorage', err)
    return fallback
  }
}

export function saveTopbarLayout(items: TopbarActionState[]): TopbarActionState[] {
  const normalized = normalizeLayout(items) ?? defaultTopbarLayout()
  if (!canUseLocalStorage()) {
    console.warn('[topbarLayout] 无法写入 localStorage')
    return normalized
  }
  try {
    localStorage.setItem(TOPBAR_LAYOUT_LS_KEY, JSON.stringify(normalized))
  } catch (err) {
    console.warn('[topbarLayout] 无法写入 localStorage', err)
  }
  return normalized
}

/** 其它标签页写入同一键时回调。返回取消订阅。 */
export function subscribeTopbarLayout(onChange: (items: TopbarActionState[]) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const handler = (event: StorageEvent) => {
    if (event.key !== TOPBAR_LAYOUT_LS_KEY) return
    onChange(loadTopbarLayout())
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}
