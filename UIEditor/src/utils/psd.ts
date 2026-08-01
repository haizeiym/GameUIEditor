/**
 * 高性能 PSD 解析工具（基于 ag-psd）。
 * 准确解析图层组 / 像素图层，导出 PNG，并生成中心锚点坐标系下的 UI 节点树。
 */
import { readPsd, type Layer } from 'ag-psd'
import type { UINode } from '../types'
import { createNode, serializeForDisk } from './node'

export interface ParsedPsdLayerImage {
  fileName: string
  /** 项目相对路径，如 A/UI/bg.png */
  relativePath: string
  blob: Blob
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
  documentWidth: number
  documentHeight: number
  layerCount: number
}

/** 清理为安全的文件/文件夹名 */
export function sanitizeFsName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned || 'untitled'
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('图层导出 PNG 失败'))
    }, 'image/png')
  })
}

function layerBounds(layer: Layer, canvas?: HTMLCanvasElement) {
  const left = layer.left ?? 0
  const top = layer.top ?? 0
  const right = layer.right ?? left + (canvas?.width ?? 0)
  const bottom = layer.bottom ?? top + (canvas?.height ?? 0)
  const width = Math.max(1, right - left)
  const height = Math.max(1, bottom - top)
  return { left, top, right, bottom, width, height }
}

/** PSD 左上角坐标系 → 编辑器中心原点坐标系 */
function toCenterCoords(
  left: number,
  top: number,
  width: number,
  height: number,
  docW: number,
  docH: number,
) {
  return {
    x: Math.round(left + width / 2 - docW / 2),
    y: Math.round(top + height / 2 - docH / 2),
  }
}

/**
 * 解析 PSD 文件：导出各图层 PNG，构建 UI JSON。
 * 目录约定：项目/{A}/UI/*.png + 项目/{A}/{A}.json
 */
export async function parsePsdFile(file: File): Promise<PsdImportResult> {
  const baseName = sanitizeFsName(file.name.replace(/\.psd$/i, ''))
  const buffer = await file.arrayBuffer()
  // 浏览器环境 readPsd 会自动生成 layer.canvas
  const psd = readPsd(buffer)

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

  const convertLayer = async (layer: Layer, zIndex: number): Promise<UINode | null> => {
    const name = layer.name?.trim() || `Layer_${zIndex}`

    // 图层组：递归子图层（PSD 子列表自下而上，反转为自上而下的 zIndex）
    if (layer.children && layer.children.length > 0) {
      const node = createNode(name, zIndex)
      node.active = !layer.hidden
      const kids: UINode[] = []
      const ordered = [...layer.children].reverse()
      for (let i = 0; i < ordered.length; i++) {
        const child = await convertLayer(ordered[i], i)
        if (child) kids.push(child)
      }
      if (!kids.length) return null
      node.children = kids

      const b = layerBounds(layer)
      // 组若无有效包围盒，用子节点估算
      if (b.width <= 1 && b.height <= 1 && kids.length) {
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
        node.width = Math.max(1, Math.round(maxX - minX))
        node.height = Math.max(1, Math.round(maxY - minY))
        node.x = Math.round((minX + maxX) / 2)
        node.y = Math.round((minY + maxY) / 2)
      } else {
        node.width = b.width
        node.height = b.height
        const c = toCenterCoords(b.left, b.top, b.width, b.height, psd.width, psd.height)
        node.x = c.x
        node.y = c.y
      }
      return node
    }

    // 像素图层：需要 canvas
    if (!layer.canvas) return null

    const b = layerBounds(layer, layer.canvas)
    const fileName = uniquePngName(name)
    const relativePath = `${baseName}/UI/${fileName}`
    const blob = await canvasToPngBlob(layer.canvas)
    images.push({
      fileName,
      relativePath,
      blob,
      width: b.width,
      height: b.height,
    })
    layerCount += 1

    const node = createNode(name, zIndex)
    node.active = !layer.hidden
    node.width = b.width
    node.height = b.height
    const c = toCenterCoords(b.left, b.top, b.width, b.height, psd.width, psd.height)
    node.x = c.x
    node.y = c.y

    if (typeof layer.opacity === 'number' && layer.opacity < 255) {
      node.components['OpacityComponent'] = {
        opacity: Math.round((layer.opacity / 255) * 1000) / 1000,
      }
    }
    node.components['SpriteComponent'] = {
      framePath: relativePath,
      color: '#FFFFFF',
      sizeMode: 2,
      type: 1,
    }
    return node
  }

  const root = createNode('Root')
  root.width = psd.width
  root.height = psd.height

  const topLayers = [...(psd.children ?? [])].reverse()
  for (let i = 0; i < topLayers.length; i++) {
    const node = await convertLayer(topLayers[i], i)
    if (node) root.children.push(node)
  }

  return {
    baseName,
    folderPath: baseName,
    uiFolderPath: `${baseName}/UI`,
    jsonPath: `${baseName}/${baseName}.json`,
    jsonContent: serializeForDisk(root),
    images,
    documentWidth: psd.width,
    documentHeight: psd.height,
    layerCount,
  }
}
