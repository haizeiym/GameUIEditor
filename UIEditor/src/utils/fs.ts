import type { FileEntry } from '../types'

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp']

export function isImageFile(name: string): boolean {
  const lower = name.toLowerCase()
  return IMAGE_EXTS.some((ext) => lower.endsWith(ext))
}

export async function readTextFile(handle: FileSystemFileHandle): Promise<string> {
  const file = await handle.getFile()
  return file.text()
}

export async function writeTextFile(handle: FileSystemFileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
}

export async function writeBinaryFile(
  handle: FileSystemFileHandle,
  data: BufferSource | Blob | Uint8Array,
): Promise<void> {
  const writable = await handle.createWritable()
  // Uint8Array 在部分 TS DOM 类型下与 BufferSource 不兼容，统一拷贝为 ArrayBuffer 视图
  const payload =
    data instanceof Uint8Array
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : data
  await writable.write(payload as BufferSource | Blob)
  await writable.close()
}

/** 按项目相对路径获取文件句柄，如 "assets/icon.png" */
export async function getFileHandleByPath(
  root: FileSystemDirectoryHandle,
  path: string,
  create = false,
): Promise<FileSystemFileHandle | null> {
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return null
  try {
    let dir = root
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create })
    }
    return await dir.getFileHandle(parts[parts.length - 1], { create })
  } catch {
    return null
  }
}

/** 按项目相对路径获取目录句柄，如 "A/UI" */
export async function getDirectoryHandleByPath(
  root: FileSystemDirectoryHandle,
  path: string,
  create = false,
): Promise<FileSystemDirectoryHandle | null> {
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return root
  try {
    let dir = root
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create })
    }
    return dir
  } catch {
    return null
  }
}

/** 删除项目相对路径上的文件或文件夹（文件夹递归删除） */
export async function removeEntryByPath(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<void> {
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) throw new Error('不能删除项目根目录')
  let dir = root
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i])
  }
  await dir.removeEntry(parts[parts.length - 1], { recursive: true })
}

export function parentDirPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

/** 去掉祖先也在集合中的路径（子随父移动） */
export function topLevelEntryPaths(paths: string[]): string[] {
  const set = new Set(paths.map((p) => p.trim()).filter(Boolean))
  return [...set]
    .filter((p) => {
      const parts = p.split('/').filter(Boolean)
      for (let i = 1; i < parts.length; i++) {
        if (set.has(parts.slice(0, i).join('/'))) return false
      }
      return true
    })
    .sort((a, b) => a.localeCompare(b))
}

export function remapMovedPath(path: string, from: string, to: string): string {
  if (path === from) return to
  if (from && path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`
  return path
}

async function hasChildNamed(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  } catch {
    /* 不是文件 */
  }
  try {
    await dir.getDirectoryHandle(name)
    return true
  } catch {
    return false
  }
}

async function copyDirectory(
  src: FileSystemDirectoryHandle,
  destParent: FileSystemDirectoryHandle,
  destName: string,
): Promise<void> {
  const dest = await destParent.getDirectoryHandle(destName, { create: true })
  for await (const child of src.values()) {
    if (child.kind === 'file') {
      const file = await (child as FileSystemFileHandle).getFile()
      const out = await dest.getFileHandle(child.name, { create: true })
      await writeBinaryFile(out, new Uint8Array(await file.arrayBuffer()))
    } else {
      await copyDirectory(child as FileSystemDirectoryHandle, dest, child.name)
    }
  }
}

/** 复制文件或文件夹到新路径（不删源）。目标已存在则失败。 */
export async function copyEntryByPath(
  root: FileSystemDirectoryHandle,
  srcPath: string,
  destPath: string,
): Promise<void> {
  const srcParts = srcPath.split('/').filter(Boolean)
  const destParts = destPath.split('/').filter(Boolean)
  if (!srcParts.length || !destParts.length) throw new Error('无效路径')
  if (srcPath === destPath) return
  if (destPath === srcPath || destPath.startsWith(`${srcPath}/`)) {
    throw new Error('不能复制到自身或子目录')
  }
  const srcParent = await getDirectoryHandleByPath(root, srcParts.slice(0, -1).join('/'))
  const destParent = await getDirectoryHandleByPath(root, destParts.slice(0, -1).join('/'), true)
  if (!srcParent || !destParent) throw new Error('找不到源或目标目录')
  const srcName = srcParts[srcParts.length - 1]!
  const destName = destParts[destParts.length - 1]!
  if (await hasChildNamed(destParent, destName)) {
    throw new Error(`目标已存在：${destPath}`)
  }
  try {
    const fileHandle = await srcParent.getFileHandle(srcName)
    const file = await fileHandle.getFile()
    const out = await destParent.getFileHandle(destName, { create: true })
    await writeBinaryFile(out, new Uint8Array(await file.arrayBuffer()))
    return
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('目标已存在')) throw err
  }
  const dirHandle = await srcParent.getDirectoryHandle(srcName)
  await copyDirectory(dirHandle, destParent, destName)
}

/** 移动：先复制再删除源 */
export async function moveEntryByPath(
  root: FileSystemDirectoryHandle,
  srcPath: string,
  destPath: string,
): Promise<void> {
  if (srcPath === destPath) return
  await copyEntryByPath(root, srcPath, destPath)
  await removeEntryByPath(root, srcPath)
}

function shouldSkip(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules'
}

/** 递归构建项目文件树（目录在前，按名称排序） */
export async function buildFileTree(
  dir: FileSystemDirectoryHandle,
  basePath = '',
): Promise<FileEntry[]> {
  const entries: FileEntry[] = []
  for await (const handle of dir.values()) {
    if (shouldSkip(handle.name)) continue
    const path = basePath ? `${basePath}/${handle.name}` : handle.name
    if (handle.kind === 'directory') {
      const dirHandle = handle as FileSystemDirectoryHandle
      entries.push({
        name: handle.name,
        path,
        kind: 'directory',
        handle: dirHandle,
        children: await buildFileTree(dirHandle, path),
      })
    } else {
      entries.push({ name: handle.name, path, kind: 'file', handle: handle as FileSystemFileHandle })
    }
  }
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
  )
  return entries
}

export interface ImageFileInfo {
  name: string
  path: string
  file: File
}

/** 递归收集项目目录下所有图片文件 */
export async function collectImages(
  dir: FileSystemDirectoryHandle,
  basePath = '',
): Promise<ImageFileInfo[]> {
  const result: ImageFileInfo[] = []
  for await (const handle of dir.values()) {
    if (shouldSkip(handle.name)) continue
    const path = basePath ? `${basePath}/${handle.name}` : handle.name
    if (handle.kind === 'directory') {
      result.push(...(await collectImages(handle as FileSystemDirectoryHandle, path)))
    } else if (isImageFile(handle.name)) {
      result.push({ name: handle.name, path, file: await (handle as FileSystemFileHandle).getFile() })
    }
  }
  result.sort((a, b) => a.path.localeCompare(b.path))
  return result
}
