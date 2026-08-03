/**
 * 高性能 PSD 解析工具（基于 ag-psd）。
 * 准确解析图层组 / 像素图层，导出 PNG，并生成中心锚点坐标系下的 UI 节点树。
 *
 * 编码策略（避免浏览器加载 Node 专用 pngjs）：
 * - 浏览器：ag-psd 默认生成 layer.canvas → canvas.toBlob
 * - Node/CLI：useImageData + 动态 import('pngjs')
 *
 * 层级规则（不使用 zIndex，只靠 children 创建顺序）：
 * - Photoshop 面板自上而下与引擎渲染顺序相反。
 * - ag-psd 读盘后的 children 已是引擎顺序（底层在前），创建节点时按该顺序直接 push，禁止再 reverse。
 */
import { readPsd, type Layer } from 'ag-psd'
import type { UINode } from '../types'
import { sanitizeFsName } from './fsName'
import { createNode, serializeForDisk } from './uiNode'

export { sanitizeFsName } from './fsName'

export interface ParsedPsdLayerImage {
  fileName: string
  /** 项目相对路径，如 A/UI/bg.png */
  relativePath: string
  /** PNG 文件字节（网页 / CLI 均可直接写盘） */
  bytes: Uint8Array
  width: number
  height: number
}

export interface PsdImportResult {
  baseName: string
  folderPath: string
  uiFolderPath: string
  jsonPath: string
  jsonContent: string
  images: ParsedPsdLayerImage[]
  /** PSD 文档像素尺寸（图层坐标仍按此中心换算） */
  documentWidth: number
  documentHeight: number
  /** 写入 Root 的设计分辨率（默认横屏 1366×768，不随 PSD 文档变化） */
  rootWidth: number
  rootHeight: number
  layerCount: number
}

export interface ParsePsdOptions {
  /** 覆盖界面/目录名 */
  baseNameOverride?: string
  /** Root 宽高 = 设计分辨率；默认 1366×768，不使用 PSD 文档尺寸 */
  rootWidth?: number
  rootHeight?: number
}

const DEFAULT_ROOT_WIDTH = 1366
const DEFAULT_ROOT_HEIGHT = 768

const hasDomCanvas = typeof document !== 'undefined'

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('图层导出 PNG 失败'))
    }, 'image/png')
  })
}

/** Node：RGBA → PNG（动态加载，避免进浏览器主包） */
async function rgbaToPngBytes(
  width: number,
  height: number,
  data: Uint8Array | Uint8ClampedArray,
): Promise<Uint8Array> {
  const [{ PNG }, { Buffer }] = await Promise.all([import('pngjs'), import('buffer')])
  const png = new PNG({ width, height })
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return new Uint8Array(PNG.sync.write(png))
}

async function layerToPngBytes(
  layer: Layer,
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  if (layer.canvas) {
    const blob = await canvasToPngBlob(layer.canvas)
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: layer.canvas.width,
      height: layer.canvas.height,
    }
  }
  const imageData = layer.imageData
  if (!imageData?.data || !imageData.width || !imageData.height) return null
  const pixel = imageData.data
  const rgba =
    pixel instanceof Uint8ClampedArray || pixel instanceof Uint8Array
      ? pixel
      : new Uint8ClampedArray(pixel as ArrayLike<number>)
  const bytes = await rgbaToPngBytes(imageData.width, imageData.height, rgba)
  return { bytes, width: imageData.width, height: imageData.height }
}

/**
 * 读取 PSD 图层在文档中的像素矩形（与 PS 图层面板信息一致）。
 * 有像素数据时宽高以像素为准；位置以 layer.left/top 为准。
 */
function layerPixelRect(layer: Layer, pixelW?: number, pixelH?: number) {
  const left = layer.left ?? 0
  const top = layer.top ?? 0
  const boxW = (layer.right ?? left) - left
  const boxH = (layer.bottom ?? top) - top
  const width = Math.max(1, pixelW || boxW || 1)
  const height = Math.max(1, pixelH || boxH || 1)
  return { left, top, width, height }
}

/**
 * PSD 文档左上角坐标系下的图层矩形 → 编辑器中心锚点变换。
 */
function psdRectToEditorTransform(
  left: number,
  top: number,
  width: number,
  height: number,
  docW: number,
  docH: number,
) {
  return {
    x: left + width / 2 - docW / 2,
    y: top + height / 2 - docH / 2,
    width,
    height,
  }
}

/**
 * 规范化图层透明度到 0–1。
 * ag-psd 读盘时已做 `byte / 0xff`，值为 0–1；若遇到原始 0–255 字节再除一次。
 */
function normalizeLayerOpacity(opacity: number): number {
  const v = opacity > 1 ? opacity / 255 : opacity
  return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000
}

/** 非完全不透明时挂载 OpacityComponent */
function applyOpacityComponent(node: UINode, layer: Layer) {
  if (typeof layer.opacity !== 'number') return
  const opacity = normalizeLayerOpacity(layer.opacity)
  if (opacity >= 1) return
  node.components['OpacityComponent'] = { opacity }
}

/** 将子节点从「相对文档中心的绝对坐标」转为相对父节点 */
function toParentLocal(kids: UINode[], parentX: number, parentY: number): void {
  for (const k of kids) {
    k.x -= parentX
    k.y -= parentY
  }
}

/** 用子节点（此时仍为文档中心绝对坐标）推算组的包围盒与中心 */
function unionFromChildren(kids: UINode[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const k of kids) {
    minX = Math.min(minX, k.x - k.width / 2)
    minY = Math.min(minY, k.y - k.height / 2)
    maxX = Math.max(maxX, k.x + k.width / 2)
    maxY = Math.max(maxY, k.y + k.height / 2)
  }
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  }
}

/**
 * 解析 PSD 二进制：导出各图层 PNG，构建 UI JSON。
 * Root 使用设计分辨率（默认 1366×768），图层坐标仍相对 PSD 文档中心 (0,0)。
 */
export async function parsePsdBuffer(
  buffer: ArrayBuffer,
  sourceName: string,
  options?: string | ParsePsdOptions,
): Promise<PsdImportResult> {
  const opts: ParsePsdOptions =
    typeof options === 'string' ? { baseNameOverride: options } : (options ?? {})
  const baseName = sanitizeFsName(
    opts.baseNameOverride?.trim() || sourceName.replace(/\.psd$/i, ''),
  )
  // 浏览器用 canvas；Node 用 imageData（无 DOM）
  const psd = hasDomCanvas ? readPsd(buffer) : readPsd(buffer, { useImageData: true })

  const docW = Math.max(1, psd.width)
  const docH = Math.max(1, psd.height)
  const rootW = Math.max(1, Math.round(opts.rootWidth ?? DEFAULT_ROOT_WIDTH))
  const rootH = Math.max(1, Math.round(opts.rootHeight ?? DEFAULT_ROOT_HEIGHT))

  const images: ParsedPsdLayerImage[] = []
  const usedNames = new Set<string>()
  let layerCount = 0

  const uniquePngName = (raw: string): string => {
    const base = sanitizeFsName(raw.replace(/\.png$/i, ''))
    let candidate = `${base}.png`
    let i = 1
    while (usedNames.has(candidate.toLowerCase())) {
      candidate = `${base}_${i++}.png`
    }
    usedNames.add(candidate.toLowerCase())
    return candidate
  }

  const convertChildren = async (layers: readonly Layer[]): Promise<UINode[]> => {
    const kids: UINode[] = []
    for (const layer of layers) {
      const child = await convertLayer(layer)
      if (child) kids.push(child)
    }
    return kids
  }

  const convertLayer = async (layer: Layer): Promise<UINode | null> => {
    const name = layer.name?.trim() || 'Layer'

    if (layer.children && layer.children.length > 0) {
      const node = createNode(name)
      node.active = !layer.hidden
      applyOpacityComponent(node, layer)

      const kids = await convertChildren(layer.children)
      if (!kids.length) return null
      node.children = kids

      const box = layerPixelRect(layer)
      const hasValidGroupBox =
        (layer.right ?? 0) > (layer.left ?? 0) && (layer.bottom ?? 0) > (layer.top ?? 0)

      if (hasValidGroupBox) {
        const t = psdRectToEditorTransform(box.left, box.top, box.width, box.height, docW, docH)
        node.x = t.x
        node.y = t.y
        node.width = t.width
        node.height = t.height
      } else {
        const u = unionFromChildren(kids)
        node.x = u.x
        node.y = u.y
        node.width = u.width
        node.height = u.height
      }

      toParentLocal(kids, node.x, node.y)
      return node
    }

    const png = await layerToPngBytes(layer)
    if (!png) return null

    const rect = layerPixelRect(layer, png.width, png.height)
    const fileName = uniquePngName(name)
    const relativePath = `${baseName}/UI/${fileName}`
    images.push({
      fileName,
      relativePath,
      bytes: png.bytes,
      width: rect.width,
      height: rect.height,
    })
    layerCount += 1

    const node = createNode(name)
    node.active = !layer.hidden
    const t = psdRectToEditorTransform(rect.left, rect.top, rect.width, rect.height, docW, docH)
    node.x = t.x
    node.y = t.y
    node.width = t.width
    node.height = t.height

    applyOpacityComponent(node, layer)
    node.components['SpriteComponent'] = {
      framePath: relativePath,
      color: '#FFFFFF',
      sizeMode: 'TRIMMED',
      type: 'SIMPLE',
    }
    return node
  }

  const root = createNode('Root')
  root.width = rootW
  root.height = rootH
  root.x = 0
  root.y = 0
  root.children = await convertChildren(psd.children ?? [])

  return {
    baseName,
    folderPath: baseName,
    uiFolderPath: `${baseName}/UI`,
    jsonPath: `${baseName}/${baseName}.json`,
    jsonContent: serializeForDisk(root),
    images,
    documentWidth: docW,
    documentHeight: docH,
    rootWidth: rootW,
    rootHeight: rootH,
    layerCount,
  }
}

/**
 * 浏览器 File 入口（兼容旧调用）。
 */
export async function parsePsdFile(
  file: File,
  options?: string | ParsePsdOptions,
): Promise<PsdImportResult> {
  return parsePsdBuffer(await file.arrayBuffer(), file.name, options)
}
