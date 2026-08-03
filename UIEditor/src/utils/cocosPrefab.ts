/**
 * 将编辑器 UI JSON 导出为 Cocos Creator 3.8.x Prefab 资源包
 *（含图片、目录/资源 .meta、Prefab 内 SpriteFrame UUID 引用）。
 */
import type { UINode } from '../types'
import {
  getDirectoryHandleByPath,
  getFileHandleByPath,
  writeBinaryFile,
  writeTextFile,
} from './fs'
import { sanitizeFsName } from './fsName'

const UI_2D_LAYER = 1073741824
const TEXTURE_SUB = '6c48a'
const SPRITE_FRAME_SUB = 'f9941'

const SizeMode = { CUSTOM: 0, TRIMMED: 1, RAW: 2 } as const
const SpriteType = { SIMPLE: 0, SLICED: 1, TILED: 2, FILLED: 3 } as const

export interface CocosPrefabExportResult {
  baseName: string
  prefabPath: string
  imageCount: number
}

/** 与具体 FS 解耦的写出接口（网页 File System Access / Node fs 均可实现） */
export interface PrefabWriteFs {
  writeText(relativePath: string, text: string): Promise<void>
  writeBinary(relativePath: string, data: Uint8Array): Promise<void>
}

export interface CocosPrefabExportCoreOptions {
  baseName: string
  root: UINode
  /** 按项目相对路径读取图片字节 */
  readImageBytes: (path: string) => Promise<Uint8Array | null>
  fs: PrefabWriteFs
}

export interface CocosPrefabExportOptions {
  exportRoot: FileSystemDirectoryHandle
  baseName: string
  root: UINode
  /** 按项目相对路径读取图片 */
  readImage: (path: string) => Promise<File | null>
}

type PrefabObject = Record<string, unknown>

function resolveSizeMode(v: unknown): number {
  if (typeof v === 'string') {
    const key = v.toUpperCase() as keyof typeof SizeMode
    if (key in SizeMode) return SizeMode[key]
  }
  if (typeof v === 'number' && v >= 0 && v <= 2) return v
  return SizeMode.TRIMMED
}

function resolveSpriteType(v: unknown): number {
  if (typeof v === 'string') {
    const key = v.toUpperCase() as keyof typeof SpriteType
    if (key in SpriteType) return SpriteType[key]
  }
  if (typeof v === 'number' && v >= 0 && v <= 3) return v
  return SpriteType.SIMPLE
}

/** 由字符串种子生成稳定 UUID（同路径多次导出保持不变） */
export function stableUuid(seed: string): string {
  const hex = fnv1aHex(seed).padEnd(32, '0').slice(0, 32)
  const b12 = ((parseInt(hex.slice(12, 16), 16) & 0x0fff) | 0x5000).toString(16).padStart(4, '0')
  const b16 = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${b12}-${b16}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}

function fnv1aHex(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // 扩展为 128bit 风格：多轮混合
  let a = h >>> 0
  let b = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b) >>> 0
  let c = Math.imul(a ^ 0xc2b2ae35, 0x27d4eb2d) >>> 0
  let d = Math.imul(b ^ input.length, 0x165667b1) >>> 0
  const parts = [a, b, c, d].map((n) => n.toString(16).padStart(8, '0'))
  return parts.join('')
}

function randomFileId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = crypto.getRandomValues(new Uint8Array(22))
  let out = ''
  for (let i = 0; i < 22; i++) out += chars[bytes[i]! % 64]!
  return out
}

function parseColor(hex: unknown): { r: number; g: number; b: number; a: number } {
  if (typeof hex !== 'string') return { r: 255, g: 255, b: 255, a: 255 }
  const raw = hex.trim().replace(/^#/, '')
  if (raw.length === 6 || raw.length === 8) {
    const n = parseInt(raw.slice(0, 8), 16)
    if (!Number.isFinite(n)) return { r: 255, g: 255, b: 255, a: 255 }
    if (raw.length === 6) {
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 }
    }
    return {
      r: (n >> 24) & 255,
      g: (n >> 16) & 255,
      b: (n >> 8) & 255,
      a: n & 255,
    }
  }
  return { r: 255, g: 255, b: 255, a: 255 }
}

/** 编辑器 opacity 为 0–1；兼容误写 0–255 */
function toOpacity255(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 255
  if (v <= 1) return Math.round(Math.min(Math.max(v, 0), 1) * 255)
  return Math.round(Math.min(Math.max(v, 0), 255))
}

export function collectFramePaths(root: UINode): string[] {
  const set = new Set<string>()
  const walk = (n: UINode) => {
    const sprite = n.components['SpriteComponent']
    const path = sprite?.framePath
    if (typeof path === 'string') {
      const trimmed = path.trim()
      if (trimmed) set.add(trimmed)
    }
    n.children.forEach(walk)
  }
  walk(root)
  return [...set]
}

function uniqueFileName(used: Set<string>, sourcePath: string): string {
  const raw = sourcePath.split('/').pop() || 'image.png'
  const base = sanitizeFsName(raw)
  const lower = base.toLowerCase()
  if (!used.has(lower)) {
    used.add(lower)
    return base
  }
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  let i = 1
  while (used.has(`${stem}_${i}${ext}`.toLowerCase())) i++
  const name = `${stem}_${i}${ext}`
  used.add(name.toLowerCase())
  return name
}

function extForMeta(fileName: string): string {
  const lower = fileName.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot >= 0) return lower.slice(dot)
  return '.png'
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  )
}

/** 从 PNG / JPEG 文件头读取宽高（不依赖 DOM） */
export function readImageSizeFromBytes(bytes: Uint8Array): { width: number; height: number } {
  // PNG
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) }
  }
  // JPEG
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1
        continue
      }
      const marker = bytes[i + 1]!
      if (marker === 0xd9 || marker === 0xda) break
      const len = (bytes[i + 2]! << 8) | bytes[i + 3]!
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = (bytes[i + 5]! << 8) | bytes[i + 6]!
        const width = (bytes[i + 7]! << 8) | bytes[i + 8]!
        return { width, height }
      }
      i += 2 + len
    }
  }
  // WebP (VP8X / VP8 / VP8L) — 最小支持
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
    if (chunk === 'VP8X' && bytes.length >= 30) {
      const width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16)
      const height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16)
      return { width, height }
    }
  }
  throw new Error('无法识别图片尺寸（仅支持 PNG / JPEG / WebP）')
}

function buildDirectoryMeta(uuid: string): PrefabObject {
  return {
    ver: '1.2.0',
    importer: 'directory',
    imported: true,
    uuid,
    files: [],
    subMetas: {},
    userData: {},
  }
}

function buildPrefabMeta(uuid: string, syncNodeName: string): PrefabObject {
  return {
    ver: '1.1.50',
    importer: 'prefab',
    imported: true,
    uuid,
    files: ['.json'],
    subMetas: {},
    userData: { syncNodeName },
  }
}

function buildImageMeta(
  uuid: string,
  displayName: string,
  width: number,
  height: number,
  fileExt: string,
): PrefabObject {
  const hw = width / 2
  const hh = height / 2
  return {
    ver: '1.0.27',
    importer: 'image',
    imported: true,
    uuid,
    files: ['.json', fileExt],
    subMetas: {
      [TEXTURE_SUB]: {
        importer: 'texture',
        uuid: `${uuid}@${TEXTURE_SUB}`,
        displayName,
        id: TEXTURE_SUB,
        name: 'texture',
        userData: {
          wrapModeS: 'clamp-to-edge',
          wrapModeT: 'clamp-to-edge',
          imageUuidOrDatabaseUri: uuid,
          isUuid: true,
          visible: false,
          minfilter: 'linear',
          magfilter: 'linear',
          mipfilter: 'none',
          anisotropy: 0,
        },
        ver: '1.0.22',
        imported: true,
        files: ['.json'],
        subMetas: {},
      },
      [SPRITE_FRAME_SUB]: {
        importer: 'sprite-frame',
        uuid: `${uuid}@${SPRITE_FRAME_SUB}`,
        displayName,
        id: SPRITE_FRAME_SUB,
        name: 'spriteFrame',
        userData: {
          trimThreshold: 1,
          rotated: false,
          offsetX: 0,
          offsetY: 0,
          trimX: 0,
          trimY: 0,
          width,
          height,
          rawWidth: width,
          rawHeight: height,
          borderTop: 0,
          borderBottom: 0,
          borderLeft: 0,
          borderRight: 0,
          packable: true,
          pixelsToUnit: 100,
          pivotX: 0.5,
          pivotY: 0.5,
          meshType: 0,
          vertices: {
            rawPosition: [-hw, -hh, 0, hw, -hh, 0, -hw, hh, 0, hw, hh, 0],
            indexes: [0, 1, 2, 2, 1, 3],
            uv: [0, height, width, height, 0, 0, width, 0],
            nuv: [0, 0, 1, 0, 0, 1, 1, 1],
            minPos: [-hw, -hh, 0],
            maxPos: [hw, hh, 0],
          },
          isUuid: true,
          imageUuidOrDatabaseUri: `${uuid}@${TEXTURE_SUB}`,
          atlasUuid: '',
          trimType: 'none',
        },
        ver: '1.0.12',
        imported: true,
        files: ['.json'],
        subMetas: {},
      },
    },
    userData: {
      type: 'sprite-frame',
      hasAlpha: true,
      fixAlphaTransparencyArtifacts: false,
      redirect: `${uuid}@${TEXTURE_SUB}`,
    },
  }
}

function vec3(x: number, y: number, z = 0) {
  return { __type__: 'cc.Vec3', x, y, z }
}

function quatIdentity() {
  return { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 }
}

function size(width: number, height: number) {
  return { __type__: 'cc.Size', width, height }
}

function vec2(x: number, y: number) {
  return { __type__: 'cc.Vec2', x, y }
}

function colorObj(c: { r: number; g: number; b: number; a: number }) {
  return { __type__: 'cc.Color', r: c.r, g: c.g, b: c.b, a: c.a }
}

/** 构建标准 Creator 3.8 Prefab JSON 数组 */
export function buildPrefabObjects(
  root: UINode,
  framePathToSpriteUuid: Map<string, string>,
  prefabName: string,
): PrefabObject[] {
  const objects: PrefabObject[] = []

  objects.push({
    __type__: 'cc.Prefab',
    _name: prefabName,
    _objFlags: 0,
    __editorExtras__: {},
    _native: '',
    data: { __id__: 1 },
    optimizationPolicy: 0,
    persistent: false,
  })

  const emitNode = (node: UINode, parentId: number | null): number => {
    const nodeId = objects.length
    const nodeObj: PrefabObject = {
      __type__: 'cc.Node',
      _name: node.name || 'Node',
      _objFlags: 0,
      __editorExtras__: {},
      _parent: parentId === null ? null : { __id__: parentId },
      _children: [] as { __id__: number }[],
      _active: node.active !== false,
      _components: [] as { __id__: number }[],
      _prefab: null as { __id__: number } | null,
      _lpos: vec3(node.x || 0, -(node.y || 0), 0),
      _lrot: quatIdentity(),
      _lscale: vec3(1, 1, 1),
      _mobility: 0,
      _layer: UI_2D_LAYER,
      _euler: vec3(0, 0, 0),
      _id: '',
    }
    objects.push(nodeObj)

    const childIds: number[] = []
    for (const child of node.children) {
      childIds.push(emitNode(child, nodeId))
    }
    nodeObj._children = childIds.map((id) => ({ __id__: id }))

    const compIds: number[] = []

    // UITransform
    const uitId = objects.length
    objects.push({
      __type__: 'cc.UITransform',
      _name: '',
      _objFlags: 0,
      __editorExtras__: {},
      node: { __id__: nodeId },
      _enabled: true,
      __prefab: { __id__: uitId + 1 },
      _contentSize: size(node.width || 0, node.height || 0),
      _anchorPoint: vec2(0.5, 0.5),
      _id: '',
    })
    objects.push({ __type__: 'cc.CompPrefabInfo', fileId: randomFileId() })
    compIds.push(uitId)

    const sprite = node.components['SpriteComponent']
    if (sprite) {
      const framePath = typeof sprite.framePath === 'string' ? sprite.framePath.trim() : ''
      const spriteUuid = framePath ? framePathToSpriteUuid.get(framePath) : undefined
      const type = resolveSpriteType(sprite.type)
      const sizeMode = resolveSizeMode(sprite.sizeMode)
      const c = parseColor(sprite.color)
      const spriteId = objects.length
      objects.push({
        __type__: 'cc.Sprite',
        _name: '',
        _objFlags: 0,
        __editorExtras__: {},
        node: { __id__: nodeId },
        _enabled: true,
        __prefab: { __id__: spriteId + 1 },
        _customMaterial: null,
        _srcBlendFactor: 2,
        _dstBlendFactor: 4,
        _color: colorObj(c),
        _spriteFrame: spriteUuid
          ? { __uuid__: `${spriteUuid}@${SPRITE_FRAME_SUB}`, __expectedType__: 'cc.SpriteFrame' }
          : null,
        _type: type,
        _fillType: 0,
        _sizeMode: sizeMode,
        _fillCenter: vec2(0, 0),
        _fillStart: 0,
        _fillRange: 0,
        _isTrimmedMode: sizeMode !== SizeMode.RAW,
        _useGrayscale: false,
        _atlas: null,
        _id: '',
      })
      objects.push({ __type__: 'cc.CompPrefabInfo', fileId: randomFileId() })
      compIds.push(spriteId)
    }

    const opacityComp = node.components['OpacityComponent']
    if (opacityComp && typeof opacityComp.opacity === 'number') {
      const opacityId = objects.length
      objects.push({
        __type__: 'cc.UIOpacity',
        _name: '',
        _objFlags: 0,
        __editorExtras__: {},
        node: { __id__: nodeId },
        _enabled: true,
        __prefab: { __id__: opacityId + 1 },
        _opacity: toOpacity255(opacityComp.opacity),
        _id: '',
      })
      objects.push({ __type__: 'cc.CompPrefabInfo', fileId: randomFileId() })
      compIds.push(opacityId)
    }

    const prefabInfoId = objects.length
    objects.push({
      __type__: 'cc.PrefabInfo',
      root: { __id__: 1 },
      asset: { __id__: 0 },
      fileId: randomFileId(),
      instance: null,
      targetOverrides: null,
      nestedPrefabInstanceRoots: null,
    })
    nodeObj._components = compIds.map((id) => ({ __id__: id }))
    nodeObj._prefab = { __id__: prefabInfoId }

    return nodeId
  }

  emitNode(root, null)
  return objects
}

export async function pathExists(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<boolean> {
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return true
  try {
    let dir = root
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]!)
    }
    const last = parts[parts.length - 1]!
    try {
      await dir.getDirectoryHandle(last)
      return true
    } catch {
      await dir.getFileHandle(last)
      return true
    }
  } catch {
    return false
  }
}

/**
 * IO 无关的 Prefab 导出核心：写出
 * `{baseName}/UI/*` + `{baseName}/{baseName}.prefab` + 各级 .meta
 */
export async function exportCocosPrefabCore(
  options: CocosPrefabExportCoreOptions,
): Promise<CocosPrefabExportResult> {
  const { root, readImageBytes, fs } = options
  const baseName = sanitizeFsName(options.baseName) || 'ui'
  const framePaths = collectFramePaths(root)
  const missing: string[] = []
  const usedNames = new Set<string>()
  const pathToExportName = new Map<string, string>()
  const pathToUuid = new Map<string, string>()
  const pathToBytes = new Map<string, Uint8Array>()

  for (const path of framePaths) {
    const bytes = await readImageBytes(path)
    if (!bytes) {
      missing.push(path)
      continue
    }
    pathToBytes.set(path, bytes)
    pathToExportName.set(path, uniqueFileName(usedNames, path))
    pathToUuid.set(path, stableUuid(`cocos-image:${path}`))
  }

  if (missing.length) {
    throw new Error(`缺少图片资源：\n${missing.join('\n')}`)
  }

  await fs.writeText(
    `${baseName}.meta`,
    `${JSON.stringify(buildDirectoryMeta(stableUuid(`cocos-dir:${baseName}`)), null, 2)}\n`,
  )
  await fs.writeText(
    `${baseName}/UI.meta`,
    `${JSON.stringify(buildDirectoryMeta(stableUuid(`cocos-dir:${baseName}/UI`)), null, 2)}\n`,
  )

  for (const path of framePaths) {
    const bytes = pathToBytes.get(path)!
    const exportName = pathToExportName.get(path)!
    const uuid = pathToUuid.get(path)!
    const { width, height } = readImageSizeFromBytes(bytes)
    const displayName = exportName.replace(/\.[^.]+$/, '')
    const fileExt = extForMeta(exportName)

    await fs.writeBinary(`${baseName}/UI/${exportName}`, bytes)
    await fs.writeText(
      `${baseName}/UI/${exportName}.meta`,
      `${JSON.stringify(buildImageMeta(uuid, displayName, width, height, fileExt), null, 2)}\n`,
    )
  }

  const prefabObjects = buildPrefabObjects(root, pathToUuid, baseName)
  await fs.writeText(
    `${baseName}/${baseName}.prefab`,
    `${JSON.stringify(prefabObjects, null, 2)}\n`,
  )
  await fs.writeText(
    `${baseName}/${baseName}.prefab.meta`,
    `${JSON.stringify(buildPrefabMeta(stableUuid(`cocos-prefab:${baseName}`), baseName), null, 2)}\n`,
  )

  return {
    baseName,
    prefabPath: `${baseName}/${baseName}.prefab`,
    imageCount: framePaths.length,
  }
}

/**
 * 浏览器 File System Access API 适配：将当前 UI 导出到独立目录。
 */
export async function exportCocosPrefab(
  options: CocosPrefabExportOptions,
): Promise<CocosPrefabExportResult> {
  const { exportRoot, root, readImage } = options
  // 确保包目录存在
  const baseName = sanitizeFsName(options.baseName) || 'ui'
  const packDir = await getDirectoryHandleByPath(exportRoot, baseName, true)
  if (!packDir) throw new Error('无法创建导出目录')
  const uiDir = await getDirectoryHandleByPath(packDir, 'UI', true)
  if (!uiDir) throw new Error('无法创建 UI 目录')

  return exportCocosPrefabCore({
    baseName,
    root,
    readImageBytes: async (path) => {
      const file = await readImage(path)
      if (!file) return null
      return new Uint8Array(await file.arrayBuffer())
    },
    fs: {
      writeText: async (relativePath, text) => {
        const handle = await getFileHandleByPath(exportRoot, relativePath, true)
        if (!handle) throw new Error(`无法写入 ${relativePath}`)
        await writeTextFile(handle, text)
      },
      writeBinary: async (relativePath, data) => {
        const handle = await getFileHandleByPath(exportRoot, relativePath, true)
        if (!handle) throw new Error(`无法写入 ${relativePath}`)
        await writeBinaryFile(handle, data)
      },
    },
  })
}
