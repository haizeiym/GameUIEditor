/**
 * 网页打包后没有 /__local_fs，绝对路径读不了盘。
 * 拖入 / 点选 .md 时把正文按路径缓存，导出时再用。
 */

const LS_KEY = 'uieditor.template-md-cache'
const MAX = 10

const memory = new Map<string, string>()

function canUseLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/')
}

function loadDisk(): Record<string, string> {
  if (!canUseLocalStorage()) return {}
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string' && k && v) out[k] = v
    }
    return out
  } catch (err) {
    console.warn('[templateMdCache] 无法读取 localStorage', err)
    return {}
  }
}

function saveDisk(map: Map<string, string>): void {
  if (!canUseLocalStorage()) return
  const obj: Record<string, string> = {}
  for (const [k, v] of map) obj[k] = v
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(obj))
  } catch (err) {
    console.warn('[templateMdCache] 无法写入 localStorage', err)
  }
}

function hydrateMemory(): void {
  if (memory.size) return
  for (const [k, v] of Object.entries(loadDisk())) memory.set(k, v)
}

export function rememberTemplateMd(path: string, text: string): void {
  const p = normalizePath(path)
  const body = text.trim() ? text : ''
  if (!p || !body) return
  hydrateMemory()
  const next = new Map<string, string>([[p, body]])
  for (const [k, v] of memory) {
    if (k === p) continue
    next.set(k, v)
    if (next.size >= MAX) break
  }
  memory.clear()
  for (const [k, v] of next) memory.set(k, v)
  saveDisk(memory)
}

export function getCachedTemplateMd(path: string): string | null {
  const p = normalizePath(path)
  if (!p) return null
  hydrateMemory()
  const hit = memory.get(p)
  if (hit) return hit
  const base = p.split('/').pop() || ''
  if (!base) return null
  const sameName: string[] = []
  for (const [k, v] of memory) {
    if ((k.split('/').pop() || '') === base) sameName.push(v)
  }
  return sameName.length === 1 ? sameName[0]! : null
}
