/**
 * 将当前 UI 节点树导出为 Photoshop 模版 PSD（结构 / 名称 / 显隐）。
 * 图片层不写入项目贴图，统一用占位像素，便于在 PS 里替换。
 *
 * 顺序：节点树自上而下 = children[0]…；PS 面板自上而下与之对齐。
 * ag-psd 的 children 是引擎顺序（底层在前），因此每层写入时 reverse。
 *
 * 在线 PS（Photopea / zaixianps）要求：
 * - 文档必须有 canvas 合成图
 * - 叶层必须有 canvas 像素
 * - 图层矩形必须是文档内非负整数（负 left/top 会被当成超大图拒开）
 * - 不要把普通对象当成 ImageData 传给 ag-psd
 */
import { writePsd, type Layer, type Psd } from 'ag-psd'
import type { UINode } from '../types'

const SPRITE_FILL = '#c0c0c0'
const EMPTY_FILL = '#f0f0f0'
const DOC_FILL = '#f0f0f0'

export function editorToPsdRect(
  absX: number,
  absY: number,
  width: number,
  height: number,
  docW: number,
  docH: number,
) {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const left = Math.round(absX - w / 2 + docW / 2)
  const top = Math.round(absY - h / 2 + docH / 2)
  return clipToDocument(left, top, left + w, top + h, docW, docH)
}

function clipToDocument(left: number, top: number, right: number, bottom: number, docW: number, docH: number) {
  const l = Math.max(0, Math.min(docW, left))
  const t = Math.max(0, Math.min(docH, top))
  const r = Math.max(0, Math.min(docW, right))
  const b = Math.max(0, Math.min(docH, bottom))
  if (r <= l || b <= t) {
    return { left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1 }
  }
  return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t }
}

function createSolidCanvas(width: number, height: number, fill: string): HTMLCanvasElement | undefined {
  if (typeof document === 'undefined') return undefined
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return undefined
  ctx.fillStyle = fill
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  return canvas
}

function hasSprite(node: UINode): boolean {
  return node.components['SpriteComponent'] != null
}

function layerOpacity(node: UINode): number | undefined {
  const raw = node.components['OpacityComponent']?.opacity
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  const v = raw > 1 ? raw / 255 : raw
  const opacity = Math.min(1, Math.max(0, v))
  return opacity < 1 ? opacity : undefined
}

function nodeToLayer(node: UINode, parentAbsX: number, parentAbsY: number, docW: number, docH: number): Layer {
  const absX = parentAbsX + node.x
  const absY = parentAbsY + node.y
  const rect = editorToPsdRect(absX, absY, node.width, node.height, docW, docH)
  const opacity = layerOpacity(node)
  const layer: Layer = {
    name: (node.name || 'Layer').slice(0, 255),
    hidden: node.active === false,
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    blendMode: 'normal',
  }
  if (opacity !== undefined) layer.opacity = opacity

  if (node.children.length > 0) {
    layer.opened = true
    layer.children = node.children
      .map((child) => nodeToLayer(child, absX, absY, docW, docH))
      .reverse()
    return layer
  }

  const canvas = createSolidCanvas(rect.width, rect.height, hasSprite(node) ? SPRITE_FILL : EMPTY_FILL)
  if (canvas) layer.canvas = canvas
  return layer
}

/** 构建 PSD 对象（不含写盘），供网页 / CLI 共用 */
export function buildPsdTemplate(root: UINode): Psd {
  const docW = Math.max(1, Math.round(root.width || 1))
  const docH = Math.max(1, Math.round(root.height || 1))
  const nodeLayers = (root.children ?? []).map((child) => nodeToLayer(child, 0, 0, docW, docH)).reverse()

  const background: Layer = {
    name: 'Background',
    left: 0,
    top: 0,
    right: docW,
    bottom: docH,
    blendMode: 'normal',
  }
  const bgCanvas = createSolidCanvas(docW, docH, DOC_FILL)
  if (bgCanvas) background.canvas = bgCanvas

  const canvas = createSolidCanvas(docW, docH, DOC_FILL)
  return {
    width: docW,
    height: docH,
    bitsPerChannel: 8,
    children: [background, ...nodeLayers],
    canvas,
  }
}

/** 写出 PSD 二进制（Root = 文档画布，其子节点为顶层图层） */
export function writePsdTemplate(root: UINode): ArrayBuffer {
  const psd = buildPsdTemplate(root)
  if (!psd.canvas) {
    throw new Error('当前环境无法生成 PSD 画布，请在 Chrome / Edge 中导出')
  }
  const options = { noBackground: false, trimImageData: false } as const
  try {
    return writePsd(psd, { ...options, generateThumbnail: true })
  } catch (err) {
    console.warn('[psdExport] generateThumbnail 失败，回退为无缩略图', err)
    return writePsd(psd, { ...options, generateThumbnail: false })
  }
}

/** 独立拷贝，避免 File System Access 写入共享/切片 ArrayBuffer 时截断 */
export function writePsdTemplateBytes(root: UINode): Uint8Array {
  const buffer = writePsdTemplate(root)
  return new Uint8Array(buffer).slice()
}
