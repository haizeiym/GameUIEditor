/** el-tree `node-click` 为 (data, node, instance, event)，从参数里取 Ctrl/⌘ */
export function isAdditiveClick(...args: unknown[]): boolean {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') continue
    const e = arg as { ctrlKey?: boolean; metaKey?: boolean }
    if (e.ctrlKey || e.metaKey) return true
  }
  return false
}
