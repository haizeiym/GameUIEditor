import type { UINode } from '../types'

/** 深度优先收集整棵树的 `_id`（含 root） */
export function collectNodeIds(root: UINode): string[] {
  const ids: string[] = []
  const walk = (n: UINode) => {
    ids.push(n._id)
    for (const c of n.children) walk(c)
  }
  walk(root)
  return ids
}

/** 去掉已不存在的 key，保序且去重 */
export function pruneExpandedKeys(keys: string[], root: UINode): string[] {
  const alive = new Set(collectNodeIds(root))
  const out: string[] = []
  const seen = new Set<string>()
  for (const k of keys) {
    if (!alive.has(k) || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}
