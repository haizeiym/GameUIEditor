/**
 * ImgToFileComponent.toFile 最近 10 条（仅网页）。
 */

const MAX = 10

export const RECENT_TO_FILE_LS_KEY = 'uieditor.recent-to-file'

function canUseLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

export function listRecentToFile(): string[] {
  if (!canUseLocalStorage()) return []
  try {
    const raw = localStorage.getItem(RECENT_TO_FILE_LS_KEY)
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
    console.warn('[recentToFile] 无法读取 localStorage', err)
    return []
  }
}

export function latestToFile(): string | null {
  return listRecentToFile()[0] ?? null
}

/** 同值置顶去重，最多 10 条。空串不记。 */
export function rememberToFile(raw: string): string[] {
  const v = raw.trim()
  if (!v) return listRecentToFile()
  const next = [v, ...listRecentToFile().filter((item) => item !== v)].slice(0, MAX)
  if (!canUseLocalStorage()) {
    console.warn('[recentToFile] 无法写入 localStorage')
    return next
  }
  try {
    localStorage.setItem(RECENT_TO_FILE_LS_KEY, JSON.stringify(next))
  } catch (err) {
    console.warn('[recentToFile] 无法写入 localStorage', err)
  }
  return next
}
