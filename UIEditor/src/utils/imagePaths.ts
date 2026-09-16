import { isImageFile } from './fs'

/** 资源/文件树拖到 Inspector 时携带的多路径（text/plain 仍为第一项，兼容 framePath） */
export const IMAGE_PATHS_MIME = 'application/x-uieditor-image-paths'

export function normalizeRelPath(path: string): string {
  return path.trim().replace(/\\/g, '/')
}

export function isProjectImagePath(path: string): boolean {
  const n = normalizeRelPath(path)
  if (!n || n.includes('..')) return false
  const name = n.split('/').pop() || ''
  return isImageFile(name)
}

export function readImagePathList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const p = normalizeRelPath(item)
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

export function mergeImagePaths(current: unknown, incoming: string[]): string[] {
  const out = readImagePathList(current)
  const seen = new Set(out)
  for (const item of incoming) {
    const p = normalizeRelPath(item)
    if (!isProjectImagePath(p) || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

export function writeImagePathsTransfer(dt: DataTransfer | null, paths: string[]): void {
  if (!dt) return
  const unique = mergeImagePaths([], paths)
  dt.setData('text/plain', unique[0] ?? '')
  dt.setData(IMAGE_PATHS_MIME, JSON.stringify(unique))
  dt.effectAllowed = 'copy'
}

export function readImagePathsTransfer(dt: DataTransfer | null): string[] {
  if (!dt) return []
  const packed = dt.getData(IMAGE_PATHS_MIME)
  if (packed) {
    try {
      return mergeImagePaths([], readImagePathList(JSON.parse(packed)))
    } catch {
      /* 回退 text/plain */
    }
  }
  const plain = dt.getData('text/plain')
  return mergeImagePaths([], plain ? [plain] : [])
}
