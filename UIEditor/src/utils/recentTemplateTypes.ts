/**
 * Root TemplateComponent.templateType 最近 10 条（仅网页，localStorage）。
 */

export const RECENT_TEMPLATE_TYPES_LS_KEY = 'uieditor.recent-template-types'
const MAX = 10

function canUseLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

export function listRecentTemplateTypes(): string[] {
  if (!canUseLocalStorage()) return []
  try {
    const raw = localStorage.getItem(RECENT_TEMPLATE_TYPES_LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const row of parsed) {
      if (typeof row !== 'string') continue
      const v = row.trim()
      if (!v || seen.has(v)) continue
      seen.add(v)
      out.push(v)
      if (out.length >= MAX) break
    }
    return out
  } catch (err) {
    console.warn('[recentTemplateTypes] 无法读取 localStorage', err)
    return []
  }
}

export function latestTemplateType(): string | null {
  return listRecentTemplateTypes()[0] ?? null
}

export function rememberTemplateType(raw: string): string[] {
  const v = raw.trim()
  if (!v) return listRecentTemplateTypes()
  const next = [v, ...listRecentTemplateTypes().filter((item) => item !== v)].slice(0, MAX)
  if (!canUseLocalStorage()) {
    console.warn('[recentTemplateTypes] 无法写入 localStorage')
    return next
  }
  try {
    localStorage.setItem(RECENT_TEMPLATE_TYPES_LS_KEY, JSON.stringify(next))
  } catch (err) {
    console.warn('[recentTemplateTypes] 无法写入 localStorage', err)
  }
  return next
}
