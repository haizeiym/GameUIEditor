/**
 * 网页最近导入/导出路径：localStorage 记名称，IndexedDB 记 FileSystemHandle。
 * Chrome 不提供绝对路径；句柄无法放进 localStorage。
 */
export type RecentIoKind = 'import-psd' | 'export-prefab' | 'export-psd-template'

export interface RecentIoMeta {
  id: string
  kind: RecentIoKind
  name: string
  ts: number
}

const LS_KEY = 'uieditor.recent-io-paths'
const IDB_NAME = 'uieditor-recent-io'
const IDB_STORE = 'handles'
const MAX_PER_KIND = 10

const KINDS: RecentIoKind[] = ['import-psd', 'export-prefab', 'export-psd-template']

type RecentMap = Record<RecentIoKind, RecentIoMeta[]>

function emptyMap(): RecentMap {
  return {
    'import-psd': [],
    'export-prefab': [],
    'export-psd-template': [],
  }
}

function readIndex(): RecentMap {
  const out = emptyMap()
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
    const rec = parsed as Record<string, unknown>
    for (const kind of KINDS) {
      const list = rec[kind]
      if (!Array.isArray(list)) continue
      out[kind] = list
        .filter((item): item is RecentIoMeta => {
          if (!item || typeof item !== 'object') return false
          const row = item as Record<string, unknown>
          return (
            typeof row.id === 'string' &&
            row.kind === kind &&
            typeof row.name === 'string' &&
            typeof row.ts === 'number'
          )
        })
        .slice(0, MAX_PER_KIND)
    }
  } catch {
    return emptyMap()
  }
  return out
}

function writeIndex(map: RecentMap): void {
  localStorage.setItem(LS_KEY, JSON.stringify(map))
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
  })
}

function idbOp<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, mode)
        const req = run(tx.objectStore(IDB_STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'))
      }),
  )
}

export function listRecentIo(kind: RecentIoKind): RecentIoMeta[] {
  return readIndex()[kind]
}

export async function getRecentHandle(id: string): Promise<FileSystemHandle | undefined> {
  try {
    const value = await idbOp('readonly', (store) => store.get(id))
    return value as FileSystemHandle | undefined
  } catch {
    return undefined
  }
}

export async function ensureHandlePermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite',
): Promise<boolean> {
  const opts = { mode }
  try {
    if (typeof handle.queryPermission === 'function') {
      const current = await handle.queryPermission(opts)
      if (current === 'granted') return true
    }
    if (typeof handle.requestPermission === 'function') {
      return (await handle.requestPermission(opts)) === 'granted'
    }
    return true
  } catch {
    return false
  }
}

export async function removeRecentIo(id: string): Promise<void> {
  const map = readIndex()
  for (const kind of KINDS) {
    map[kind] = map[kind].filter((row) => row.id !== id)
  }
  writeIndex(map)
  try {
    await idbOp('readwrite', (store) => store.delete(id))
  } catch {
    // 展示列表已更新即可
  }
}

export async function rememberRecentIo(kind: RecentIoKind, handle: FileSystemHandle): Promise<void> {
  const map = readIndex()
  const dropIds: string[] = []
  const kept: RecentIoMeta[] = []
  for (const row of map[kind]) {
    const old = await getRecentHandle(row.id)
    let same = row.name === handle.name
    if (old) {
      try {
        same = await old.isSameEntry(handle)
      } catch {
        same = old.name === handle.name
      }
    }
    if (same) dropIds.push(row.id)
    else kept.push(row)
  }

  const id = crypto.randomUUID()
  try {
    await idbOp('readwrite', (store) => store.put(handle, id))
  } catch (err) {
    console.warn('[recentIo] 无法保存文件句柄', err)
    return
  }

  const next = [{ id, kind, name: handle.name, ts: Date.now() }, ...kept]
  const overflow = next.slice(MAX_PER_KIND)
  map[kind] = next.slice(0, MAX_PER_KIND)
  writeIndex(map)

  for (const dropId of [...dropIds, ...overflow.map((row) => row.id)]) {
    try {
      await idbOp('readwrite', (store) => store.delete(dropId))
    } catch {
      /* ignore */
    }
  }
}

export async function latestRecentHandle(kind: RecentIoKind): Promise<FileSystemHandle | undefined> {
  const first = listRecentIo(kind)[0]
  if (!first) return undefined
  const handle = await getRecentHandle(first.id)
  if (!handle) return undefined
  const mode = kind === 'import-psd' ? 'read' : 'readwrite'
  if (!(await ensureHandlePermission(handle, mode))) return undefined
  return handle
}
