/**
 * 左栏宽 / 右栏宽 / 底栏高（仅网页，localStorage）。
 */

export const PANEL_LAYOUT_LS_KEY = 'uieditor.panel-layout'

export interface PanelLayout {
  left: number
  right: number
  bottom: number
}

export const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  left: 256,
  right: 320,
  bottom: 176,
}

export const PANEL_LIMITS = {
  left: { min: 180, max: 480 },
  right: { min: 240, max: 560 },
  bottom: { min: 72, max: 420 },
} as const

/** 左+右之外，中间画布至少这么宽 */
export const MIN_CENTER_WIDTH = 320
/** 底栏之上，画布至少这么高 */
export const MIN_CANVAS_HEIGHT = 120

function canUseLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.round(n)
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function normalizePanelLayout(
  raw: unknown,
  workspace?: { width: number; height: number },
): PanelLayout {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  let left = clamp(
    toInt(src.left, DEFAULT_PANEL_LAYOUT.left),
    PANEL_LIMITS.left.min,
    PANEL_LIMITS.left.max,
  )
  let right = clamp(
    toInt(src.right, DEFAULT_PANEL_LAYOUT.right),
    PANEL_LIMITS.right.min,
    PANEL_LIMITS.right.max,
  )
  let bottom = clamp(
    toInt(src.bottom, DEFAULT_PANEL_LAYOUT.bottom),
    PANEL_LIMITS.bottom.min,
    PANEL_LIMITS.bottom.max,
  )
  if (workspace && workspace.width > 0) {
    const budget = workspace.width - MIN_CENTER_WIDTH
    if (budget <= PANEL_LIMITS.left.min) {
      left = PANEL_LIMITS.left.min
      right = Math.max(PANEL_LIMITS.right.min, budget - left)
    } else if (left + right > budget) {
      const overflow = left + right - budget
      const shrinkL = Math.min(overflow, left - PANEL_LIMITS.left.min)
      left -= shrinkL
      right = Math.max(PANEL_LIMITS.right.min, right - (overflow - shrinkL))
    }
  }
  if (workspace && workspace.height > 0) {
    const maxH = Math.min(PANEL_LIMITS.bottom.max, workspace.height - MIN_CANVAS_HEIGHT)
    bottom = clamp(bottom, PANEL_LIMITS.bottom.min, Math.max(PANEL_LIMITS.bottom.min, maxH))
  }
  return { left, right, bottom }
}

export function loadPanelLayout(workspace?: { width: number; height: number }): PanelLayout {
  const fallback = normalizePanelLayout(DEFAULT_PANEL_LAYOUT, workspace)
  if (!canUseLocalStorage()) return fallback
  try {
    const raw = localStorage.getItem(PANEL_LAYOUT_LS_KEY)
    if (!raw) return fallback
    return normalizePanelLayout(JSON.parse(raw) as unknown, workspace)
  } catch (err) {
    console.warn('[panelLayout] 无法读取 localStorage', err)
    return fallback
  }
}

export function savePanelLayout(
  layout: PanelLayout,
  workspace?: { width: number; height: number },
): PanelLayout {
  const normalized = normalizePanelLayout(layout, workspace)
  if (!canUseLocalStorage()) {
    console.warn('[panelLayout] 无法写入 localStorage')
    return normalized
  }
  try {
    localStorage.setItem(PANEL_LAYOUT_LS_KEY, JSON.stringify(normalized))
  } catch (err) {
    console.warn('[panelLayout] 无法写入 localStorage', err)
  }
  return normalized
}

export function subscribePanelLayout(onChange: (layout: PanelLayout) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const handler = (e: StorageEvent) => {
    if (e.key !== PANEL_LAYOUT_LS_KEY || e.newValue == null) return
    try {
      onChange(normalizePanelLayout(JSON.parse(e.newValue) as unknown))
    } catch (err) {
      console.warn('[panelLayout] storage 同步失败', err)
    }
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}
