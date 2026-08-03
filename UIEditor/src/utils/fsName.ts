/** 清理为安全的文件/文件夹名（网页与 CLI 共用） */
export function sanitizeFsName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned || 'untitled'
}
