/**
 * TemplateComponent 的 templateType / templateAlias / templatePath 最近 10 条（仅网页）。
 */

const MAX = 10

export const RECENT_TEMPLATE_TYPES_LS_KEY = 'uieditor.recent-template-types'
export const RECENT_TEMPLATE_ALIASES_LS_KEY = 'uieditor.recent-template-aliases'
export const RECENT_TEMPLATE_PATHS_LS_KEY = 'uieditor.recent-template-paths'

function canUseLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

function listRecent(key: string): string[] {
  if (!canUseLocalStorage()) return []
  try {
    const raw = localStorage.getItem(key)
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

function remember(key: string, raw: string): string[] {
  const v = raw.trim()
  if (!v) return listRecent(key)
  const next = [v, ...listRecent(key).filter((item) => item !== v)].slice(0, MAX)
  if (!canUseLocalStorage()) {
    console.warn('[recentTemplateTypes] 无法写入 localStorage')
    return next
  }
  try {
    localStorage.setItem(key, JSON.stringify(next))
  } catch (err) {
    console.warn('[recentTemplateTypes] 无法写入 localStorage', err)
  }
  return next
}

export function listRecentTemplateTypes(): string[] {
  return listRecent(RECENT_TEMPLATE_TYPES_LS_KEY)
}

export function latestTemplateType(): string | null {
  return listRecentTemplateTypes()[0] ?? null
}

export function rememberTemplateType(raw: string): string[] {
  return remember(RECENT_TEMPLATE_TYPES_LS_KEY, raw)
}

export function listRecentTemplatePaths(): string[] {
  return listRecent(RECENT_TEMPLATE_PATHS_LS_KEY)
}

export function latestTemplatePath(): string | null {
  return listRecentTemplatePaths()[0] ?? null
}

export function rememberTemplatePath(raw: string): string[] {
  return remember(RECENT_TEMPLATE_PATHS_LS_KEY, raw)
}

export function listRecentTemplateAliases(): string[] {
  return listRecent(RECENT_TEMPLATE_ALIASES_LS_KEY)
}

export function latestTemplateAlias(): string | null {
  return listRecentTemplateAliases()[0] ?? null
}

export function rememberTemplateAlias(raw: string): string[] {
  return remember(RECENT_TEMPLATE_ALIASES_LS_KEY, raw)
}
