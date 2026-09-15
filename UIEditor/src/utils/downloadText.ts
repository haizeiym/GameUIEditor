/**
 * 导出前下载远程文本（http/https），带字节进度；网页与 CLI 共用 fetch。
 */

export const MAX_TEMPLATE_DOWNLOAD_BYTES = 2 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000

export function formatByteSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export type DownloadTextProgress = (loaded: number, total: number | null) => Promise<void> | void

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let len = 0
  for (const c of chunks) len += c.byteLength
  const out = new Uint8Array(len)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 256).trim().toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html')
}

/** 流式下载 UTF-8 文本；超限 / 非 2xx / 超时 / HTML 页则失败 */
export async function downloadTextWithProgress(
  url: string,
  onProgress?: DownloadTextProgress,
): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      throw new Error(
        aborted
          ? `下载模板超时（${DOWNLOAD_TIMEOUT_MS / 1000}s）：${url}`
          : `无法下载模板（网络或跨域）：${url}`,
      )
    }

    if (!res.ok) {
      throw new Error(`下载模板失败 HTTP ${res.status}：${url}`)
    }

    const headerLen = Number(res.headers.get('content-length'))
    const total = Number.isFinite(headerLen) && headerLen > 0 ? headerLen : null
    if (total != null && total > MAX_TEMPLATE_DOWNLOAD_BYTES) {
      throw new Error(
        `模板过大（${formatByteSize(total)}，上限 ${formatByteSize(MAX_TEMPLATE_DOWNLOAD_BYTES)}）：${url}`,
      )
    }

    let loaded = 0
    let lastEmit = 0
    const emit = async (force: boolean) => {
      const now = Date.now()
      if (!force && now - lastEmit < 80) return
      lastEmit = now
      await onProgress?.(loaded, total)
    }

    let bytes: Uint8Array
    if (!res.body || typeof res.body.getReader !== 'function') {
      const buf = new Uint8Array(await res.arrayBuffer())
      loaded = buf.byteLength
      if (loaded > MAX_TEMPLATE_DOWNLOAD_BYTES) {
        throw new Error(
          `模板过大（${formatByteSize(loaded)}，上限 ${formatByteSize(MAX_TEMPLATE_DOWNLOAD_BYTES)}）：${url}`,
        )
      }
      await emit(true)
      bytes = buf
    } else {
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.byteLength) continue
        chunks.push(value)
        loaded += value.byteLength
        if (loaded > MAX_TEMPLATE_DOWNLOAD_BYTES) {
          try {
            await reader.cancel()
          } catch {
            /* ignore */
          }
          throw new Error(
            `模板过大（超过 ${formatByteSize(MAX_TEMPLATE_DOWNLOAD_BYTES)}）：${url}`,
          )
        }
        await emit(false)
      }
      await emit(true)
      bytes = concatBytes(chunks)
    }

    const text = new TextDecoder('utf-8').decode(bytes)
    if (!text.trim()) {
      throw new Error(`下载的模板为空：${url}`)
    }
    if (looksLikeHtml(text)) {
      throw new Error(`下载结果是 HTML 页面，请使用 raw 地址（如 raw.githubusercontent.com）：${url}`)
    }
    return text
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`下载模板超时（${DOWNLOAD_TIMEOUT_MS / 1000}s）：${url}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
