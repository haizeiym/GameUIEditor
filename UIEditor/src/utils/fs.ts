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
  data: BufferSource | Blob,
): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(data)
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
