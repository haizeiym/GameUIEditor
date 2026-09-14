/**
 * 带 scriptPath / scriptUuid 的组件：本机记住每种类型最近 3 次绑定（仅网页）。
 */
import type { ComponentDef } from '../types'

export interface RecentScriptBind {
  scriptPath: string
  scriptUuid: string
}

export const RECENT_SCRIPT_BINDS_LS_KEY = 'uieditor.recent-script-binds'
const MAX_PER_TYPE = 3

export function hasScriptBindProps(def: ComponentDef | undefined): boolean {
  const props = def?.properties
  return Boolean(props && 'scriptPath' in props && 'scriptUuid' in props)
}

function canUseLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

function readAll(): Record<string, RecentScriptBind[]> {
  if (!canUseLocalStorage()) return {}
  try {
    const raw = localStorage.getItem(RECENT_SCRIPT_BINDS_LS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, RecentScriptBind[]> = {}
    for (const [type, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof type !== 'string' || !type || !Array.isArray(list)) continue
      const rows: RecentScriptBind[] = []
      const seen = new Set<string>()
      for (const row of list) {
        if (!row || typeof row !== 'object') continue
        const rec = row as Record<string, unknown>
        const scriptPath = typeof rec.scriptPath === 'string' ? rec.scriptPath.trim() : ''
        const scriptUuid = typeof rec.scriptUuid === 'string' ? rec.scriptUuid.trim() : ''
        if (!scriptPath || !scriptUuid || seen.has(scriptPath)) continue
        seen.add(scriptPath)
        rows.push({ scriptPath, scriptUuid })
        if (rows.length >= MAX_PER_TYPE) break
      }
      if (rows.length) out[type] = rows
    }
    return out
  } catch (err) {
    console.warn('[recentScriptBinds] 无法读取 localStorage', err)
    return {}
  }
}

function writeAll(map: Record<string, RecentScriptBind[]>): void {
  if (!canUseLocalStorage()) {
    console.warn('[recentScriptBinds] 无法写入 localStorage')
    return
  }
  try {
    localStorage.setItem(RECENT_SCRIPT_BINDS_LS_KEY, JSON.stringify(map))
  } catch (err) {
    console.warn('[recentScriptBinds] 无法写入 localStorage', err)
  }
}

export function listRecentScriptBinds(componentType: string): RecentScriptBind[] {
  if (!componentType) return []
  return readAll()[componentType] ?? []
}

export function latestScriptBind(componentType: string): RecentScriptBind | null {
  return listRecentScriptBinds(componentType)[0] ?? null
}

/** 同路径置顶；每种组件最多 3 条。 */
export function rememberScriptBind(
  componentType: string,
  scriptPath: string,
  scriptUuid: string,
): RecentScriptBind[] {
  const path = scriptPath.trim()
  const uuid = scriptUuid.trim()
  if (!componentType || !path || !uuid) return listRecentScriptBinds(componentType)
  const map = readAll()
  const next = [
    { scriptPath: path, scriptUuid: uuid },
    ...(map[componentType] ?? []).filter((row) => row.scriptPath !== path),
  ].slice(0, MAX_PER_TYPE)
  map[componentType] = next
  writeAll(map)
  return next
}
