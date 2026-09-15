/**
 * 将编辑器 UI JSON 导出为 Cocos Creator 3.8.x Prefab 资源包
 *（含图片、目录/资源 .meta、Prefab 内 SpriteFrame UUID 引用）。
 */
import type { ComponentDef, ComponentDefs, UINode } from '../types'
import {
  createExportProgressReporter,
  type OnExportProgress,
} from './exportProgress'
import {
  getDirectoryHandleByPath,
  getFileHandleByPath,
  writeBinaryFile,
  writeTextFile,
} from './fs'
import { uniqueImageFileName, toExportBaseName } from './imageFileName'
import {
  buildPrefabScriptSource,
  buildTypescriptMeta,
  readRootTemplateType,
} from './prefabTsTemplate'
import { findDescendantByPath, resolveNodeRef, resolveScriptBindField } from './uiNode'

const UI_2D_LAYER = 1073741824
const TEXTURE_SUB = '6c48a'
const SPRITE_FRAME_SUB = 'f9941'

const SizeMode = { CUSTOM: 0, TRIMMED: 1, RAW: 2 } as const
const SpriteType = { SIMPLE: 0, SLICED: 1, TILED: 2, FILLED: 3 } as const
/** Cocos HorizontalTextAlignment / VerticalTextAlignment */
const TextAlign = { LEFT: 0, CENTER: 1, RIGHT: 2, TOP: 0, BOTTOM: 2 } as const
/** Cocos Overflow */
const LabelOverflow = { NONE: 0, CLAMP: 1, SHRINK: 2, RESIZE_HEIGHT: 3 } as const
/** Cocos CacheMode */
const LabelCacheMode = { NONE: 0, BITMAP: 1, CHAR: 2 } as const
/** Cocos Button.Transition：仅支持 NONE / SCALE */
const ButtonTransition = { NONE: 0, SCALE: 3 } as const

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
  /** 可选：覆盖 codePreview/cocosPrefab.md 模板原文（CLI 从磁盘注入） */
  scriptTemplateMd?: string
  /** CLI：codePreview 目录下 stem → markdown；网页走 Vite glob */
  codePreviewMarkdown?: Record<string, string>
  /** 组件库定义（SimpleList 等需 scriptName/Path/Uuid 才能绑定脚本） */
  componentDefs?: ComponentDefs
  /** 导出进度（与 UI 解耦；网页进度框 / CLI 日志均可接入） */
  onProgress?: OnExportProgress
}

export interface CocosPrefabExportOptions {
  exportRoot: FileSystemDirectoryHandle
  baseName: string
  root: UINode
  /** 按项目相对路径读取图片 */
  readImage: (path: string) => Promise<File | null>
  componentDefs?: ComponentDefs
  onProgress?: OnExportProgress
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

function resolveHAlign(v: unknown): number {
  if (typeof v === 'string') {
    const key = v.toUpperCase()
    if (key === 'LEFT') return TextAlign.LEFT
    if (key === 'RIGHT') return TextAlign.RIGHT
  }
  if (typeof v === 'number' && v >= 0 && v <= 2) return v
  return TextAlign.CENTER
}

function resolveVAlign(v: unknown): number {
  if (typeof v === 'string') {
    const key = v.toUpperCase()
    if (key === 'TOP') return TextAlign.TOP
    if (key === 'BOTTOM') return TextAlign.BOTTOM
  }
  if (typeof v === 'number' && v >= 0 && v <= 2) return v
  return TextAlign.CENTER
}

function resolveOverflow(v: unknown): number {
  if (typeof v === 'string') {
    const key = v.toUpperCase() as keyof typeof LabelOverflow
    if (key in LabelOverflow) return LabelOverflow[key]
  }
  if (typeof v === 'number' && v >= 0 && v <= 3) return v
  return LabelOverflow.NONE
}

function resolveCacheMode(v: unknown): number {
  if (typeof v === 'string') {
    const key = v.toUpperCase() as keyof typeof LabelCacheMode
    if (key in LabelCacheMode) return LabelCacheMode[key]
  }
  if (typeof v === 'number' && v >= 0 && v <= 2) return v
  return LabelCacheMode.BITMAP
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** SimpleList.itemCreationMode：编辑器存字符串，Prefab 存枚举数值 */
function resolveItemCreationMode(v: unknown): number {
  if (typeof v === 'number' && (v === 0 || v === 1)) return v
  if (typeof v === 'string') {
    const key = v.toUpperCase()
    if (key === 'NODE') return 0
    if (key === 'PREFAB') return 1
  }
  return 1
}

function nodeNameStartsWithBtn(name: string): boolean {
  return name.startsWith('Btn')
}

/** Button.transition：NONE=0, SCALE=3（缺省 SCALE） */
function resolveButtonTransition(v: unknown): number {
  if (typeof v === 'string') {
    const key = v.trim().toUpperCase()
    if (key === 'NONE') return ButtonTransition.NONE
    if (key === 'SCALE') return ButtonTransition.SCALE
  }
  if (v === ButtonTransition.NONE || v === ButtonTransition.SCALE) return v
  return ButtonTransition.SCALE
}

/**
 * 导出用 Button 数据：已有 ButtonComponent 则用它；否则节点名 `Btn` 开头时按缺省补一份（不回写 JSON）。
 */
function resolveButtonSource(node: UINode): Record<string, unknown> | null {
  const existing = node.components['ButtonComponent']
  if (existing) return existing
  if (nodeNameStartsWithBtn(node.name || '')) {
    return { target: '.', transition: 'SCALE' }
  }
  return null
}

/**
 * 解析脚本绑定 UUID。
 * 优先级：实例 scriptUuid > 定义 scriptUuid > path 若本身是 UUID > path 稳定种子。
 * 导出要求必须能解析出 UUID，否则返回 null。
 */
export function resolveSimpleListScriptUuid(
  instance: Record<string, unknown> | undefined,
  def: ComponentDef | undefined,
): string | null {
  const fromInstance =
    typeof instance?.scriptUuid === 'string' ? instance.scriptUuid.trim() : ''
  if (fromInstance && UUID_RE.test(fromInstance)) return fromInstance.toLowerCase()

  if (def) {
    const explicit = resolveScriptBindField(def.scriptUuid)
    if (explicit && UUID_RE.test(explicit)) return explicit.toLowerCase()
  }

  const pathFromInstance =
    typeof instance?.scriptPath === 'string' ? instance.scriptPath.trim() : ''
  const pathFromDef = def ? resolveScriptBindField(def.scriptPath) : ''
  const scriptPath = pathFromInstance || pathFromDef
  if (!scriptPath) return null
  if (UUID_RE.test(scriptPath)) return scriptPath.toLowerCase()
  return null
}

/** @deprecated 使用 resolveSimpleListScriptUuid */
export function resolveComponentScriptUuid(def: ComponentDef | undefined): string | null {
  return resolveSimpleListScriptUuid(undefined, def)
}

/** 由字符串种子生成稳定 UUID（同路径多次导出保持不变） */
export function stableUuid(seed: string, version: 4 | 5 = 5): string {
  const hex = fnv1aHex(seed).padEnd(32, '0').slice(0, 32)
  const verBits = version === 4 ? 0x4000 : 0x5000
  const b12 = ((parseInt(hex.slice(12, 16), 16) & 0x0fff) | verBits).toString(16).padStart(4, '0')
  const b16 = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${b12}-${b16}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}

const COCOS_BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Creator 非 min 压缩 UUID（23 字符）：保留前 5 位 hex，其余每 3 hex → 2 base64。
 * Prefab 内自定义脚本组件的 `__type__` 使用该值（对应 `.ts.meta` 的 uuid）。
 */
export function compressUuid(uuid: string): string {
  const hex = uuid.replace(/-/g, '').toLowerCase()
  if (hex.length !== 32 || !/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`非法 UUID，无法压缩：${uuid}`)
  }
  const reserved = hex.slice(0, 5)
  const rest = hex.slice(5)
  let out = reserved
  for (let i = 0; i < rest.length; i += 3) {
    const v = parseInt(rest.slice(i, i + 3), 16)
    out += COCOS_BASE64[(v >> 6) & 63]! + COCOS_BASE64[v & 63]!
  }
  return out
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

export type SpriteExportSubdir = 'UI' | 'UI/zh'

export interface ImageExportJob {
  sourcePath: string
  subdir: SpriteExportSubdir
}

/**
 * 每个 framePath 只导出一份。任意引用节点挂了 LangSpriteComponent → UI/zh，否则 UI/。
 * UI/zh 必须使用与 UI/ 不同的 UUID 种子，Prefab 按本表重绑 `_spriteFrame`。
 */
export function collectImageExportJobs(root: UINode): ImageExportJob[] {
  const byPath = new Map<string, ImageExportJob>()
  const walk = (n: UINode) => {
    const sprite = n.components['SpriteComponent']
    const path = sprite?.framePath
    if (typeof path === 'string') {
      const trimmed = path.trim()
      if (trimmed) {
        const langZh = Boolean(n.components['LangSpriteComponent'])
        const prev = byPath.get(trimmed)
        if (!prev) {
          byPath.set(trimmed, { sourcePath: trimmed, subdir: langZh ? 'UI/zh' : 'UI' })
        } else if (langZh) {
          prev.subdir = 'UI/zh'
        }
      }
    }
    n.children.forEach(walk)
  }
  walk(root)
  return [...byPath.values()]
}

export function collectFramePaths(root: UINode): string[] {
  return [...new Set(collectImageExportJobs(root).map((j) => j.sourcePath))]
}

/** UI/ 保持原种子；进 UI/zh 必须换 UUID，导出时 Prefab 按新 UUID 重绑 */
export function imageUuidSeed(sourcePath: string, subdir: SpriteExportSubdir): string {
  if (subdir === 'UI/zh') return `cocos-image:UI/zh:${sourcePath}`
  return `cocos-image:${sourcePath}`
}

function uniqueFileName(used: Set<string>, sourcePath: string): string {
  const raw = sourcePath.split('/').pop() || 'image.png'
  const dot = raw.lastIndexOf('.')
  const ext = dot > 0 ? raw.slice(dot) : '.png'
  return uniqueImageFileName(used, raw, ext)
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

function buildDirectoryMeta(uuid: string, imported = true): PrefabObject {
  return {
    ver: '1.2.0',
    importer: 'directory',
    imported,
    uuid,
    files: [],
    subMetas: {},
    userData: {},
  }
}

function buildPrefabMeta(uuid: string, syncNodeName: string, imported = true): PrefabObject {
  return {
    ver: '1.1.50',
    importer: 'prefab',
    imported,
    uuid,
    files: imported ? ['.json'] : [],
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
  imported = true,
): PrefabObject {
  const hw = width / 2
  const hh = height / 2
  const libFiles = imported ? ['.json'] : []
  return {
    ver: '1.0.27',
    importer: 'image',
    imported,
    uuid,
    files: imported ? ['.json', fileExt] : [],
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
        imported,
        files: libFiles,
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
        imported,
        files: libFiles,
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

/** 构建标准 Creator 3.8 Prefab JSON 数组；scriptUuid 非空时挂到根节点 */
export function buildPrefabObjects(
  root: UINode,
  framePathToSpriteUuid: Map<string, string>,
  prefabName: string,
  scriptUuid?: string,
  componentDefs?: ComponentDefs,
  framePathToExportName: Map<string, string> = new Map(),
): PrefabObject[] {
  const objects: PrefabObject[] = []
  const scriptType = scriptUuid ? compressUuid(scriptUuid) : null
  const defs = componentDefs ?? {}
  /** UINode._id → Prefab 中 cc.Node 的 __id__ */
  const uiIdToPrefabId = new Map<string, number>()

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

  const emitNode = (node: UINode, parentId: number | null, parentUI: UINode | null): number => {
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
    uiIdToPrefabId.set(node._id, nodeId)

    const childIds: number[] = []
    for (const child of node.children) {
      childIds.push(emitNode(child, nodeId, node))
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

    // SimpleList 的 view 节点：自动挂 Mask（矩形裁剪）
    if (
      node.name === 'view' &&
      parentUI?.components['SimpleListComponent']
    ) {
      const maskId = objects.length
      objects.push({
        __type__: 'cc.Mask',
        _name: '',
        _objFlags: 0,
        __editorExtras__: {},
        node: { __id__: nodeId },
        _enabled: true,
        __prefab: { __id__: maskId + 1 },
        _type: 0,
        _inverted: false,
        _segments: 64,
        _alphaThreshold: 0.1,
        _id: '',
      })
      objects.push({ __type__: 'cc.CompPrefabInfo', fileId: randomFileId() })
      compIds.push(maskId)
    }

    const sprite = node.components['SpriteComponent']
    if (sprite) {
      const framePath = typeof sprite.framePath === 'string' ? sprite.framePath.trim() : ''
      /** 绑定本导出份的 UUID：进 UI/zh 后已是新种子，与 .meta 一致 */
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

    const label = node.components['LabelComponent']
    if (label) {
      const c = parseColor(label.color)
      const fontSize = typeof label.fontSize === 'number' ? label.fontSize : 24
      const lineHeight = typeof label.lineHeight === 'number' ? label.lineHeight : fontSize
      const fontFamily =
        typeof label.fontFamily === 'string' && label.fontFamily.trim()
          ? label.fontFamily
          : 'Arial'
      const labelId = objects.length
      objects.push({
        __type__: 'cc.Label',
        _name: '',
        _objFlags: 0,
        __editorExtras__: {},
        node: { __id__: nodeId },
        _enabled: true,
        __prefab: { __id__: labelId + 1 },
        _customMaterial: null,
        _srcBlendFactor: 2,
        _dstBlendFactor: 4,
        _color: colorObj(c),
        _string: typeof label.text === 'string' ? label.text : '',
        _horizontalAlign: resolveHAlign(label.horizontalAlign),
        _verticalAlign: resolveVAlign(label.verticalAlign),
        _actualFontSize: fontSize,
        _fontSize: fontSize,
        _fontFamily: fontFamily,
        _lineHeight: lineHeight,
        _overflow: resolveOverflow(label.overflow),
        _enableWrapText: label.enableWrapText === true,
        _font: null,
        _isSystemFontUsed: true,
        _spacingX: 0,
        _isItalic: false,
        _isBold: label.isBold === true,
        _isUnderline: false,
        _underlineHeight: 2,
        _cacheMode: resolveCacheMode(label.cacheMode),
        _enableOutline: false,
        _outlineColor: colorObj({ r: 0, g: 0, b: 0, a: 255 }),
        _outlineWidth: 2,
        _enableShadow: false,
        _shadowColor: colorObj({ r: 0, g: 0, b: 0, a: 255 }),
        _shadowOffset: vec2(2, 2),
        _shadowBlur: 2,
        _id: '',
      })
      objects.push({ __type__: 'cc.CompPrefabInfo', fileId: randomFileId() })
      compIds.push(labelId)
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

    // SimpleList：先挂 ScrollView（Horizontal/Vertical），再按 components.json 绑定脚本
    const simpleList = node.components['SimpleListComponent']
    if (simpleList) {
      // viewNode → content；缺省回退 view/content
      const viewNodeRef =
        typeof simpleList.viewNode === 'string' && simpleList.viewNode.trim()
          ? simpleList.viewNode.trim()
          : 'view/content'
      const contentUI = findDescendantByPath(node, viewNodeRef)
      const contentPrefabId = contentUI ? uiIdToPrefabId.get(contentUI._id) : undefined

      const scrollId = objects.length
      objects.push({
        __type__: 'cc.ScrollView',
        _name: '',
        _objFlags: 0,
        __editorExtras__: {},
        node: { __id__: nodeId },
        _enabled: true,
        __prefab: { __id__: scrollId + 1 },
        bounceDuration: 0.23,
        brake: 0.75,
        elastic: true,
        inertia: true,
        horizontal: simpleList.Horizontal === true,
        vertical: simpleList.Vertical === true,
        cancelInnerEvents: true,
        scrollEvents: [],
        _content: contentPrefabId != null ? { __id__: contentPrefabId } : null,
        _horizontalScrollBar: null,
        _verticalScrollBar: null,
        _id: '',
      })
      objects.push({ __type__: 'cc.CompPrefabInfo', fileId: randomFileId() })
      compIds.push(scrollId)

      const listDef = defs['SimpleListComponent']
      const listScriptUuid = resolveSimpleListScriptUuid(simpleList, listDef)
      if (listScriptUuid) {
        const listScriptType = compressUuid(listScriptUuid)
        const listId = objects.length
        objects.push({
          __type__: listScriptType,
          _name: '',
          _objFlags: 0,
          __editorExtras__: {},
          node: { __id__: nodeId },
          _enabled: true,
          __prefab: { __id__: listId + 1 },
          scrollView: { __id__: scrollId },
          itemCreationMode: resolveItemCreationMode(simpleList.itemCreationMode),
          itemPrefab: null,
          itemNode: null,
          spacing: typeof simpleList.spacing === 'number' ? simpleList.spacing : 0,
          paddingStart: typeof simpleList.paddingStart === 'number' ? simpleList.paddingStart : 0,
          paddingEnd: typeof simpleList.paddingEnd === 'number' ? simpleList.paddingEnd : 0,
          isPageMode: simpleList.isPageMode === true,
          _id: '',
        })
        objects.push({ __type__: 'cc.CompPrefabInfo', fileId: randomFileId() })
        compIds.push(listId)
      } else {
        console.warn(
          '[cocosPrefab] SimpleListComponent 缺少 scriptUuid（请设置 scriptPath 以从 .meta 自动填充），已跳过脚本绑定',
        )
      }
    }

    const buttonSrc = resolveButtonSource(node)
    if (buttonSrc) {
      const targetUI = resolveNodeRef(node, buttonSrc.target)
      const targetPrefabId = targetUI ? uiIdToPrefabId.get(targetUI._id) : undefined
      const btnId = objects.length
      objects.push({
        __type__: 'cc.Button',
        _name: '',
        _objFlags: 0,
        __editorExtras__: {},
        node: { __id__: nodeId },
        _enabled: true,
        __prefab: { __id__: btnId + 1 },
        clickEvents: [],
        _interactable: true,
        _transition: resolveButtonTransition(buttonSrc.transition),
        _normalColor: colorObj({ r: 255, g: 255, b: 255, a: 255 }),
        _hoverColor: colorObj({ r: 211, g: 211, b: 211, a: 255 }),
        _pressedColor: colorObj({ r: 255, g: 255, b: 255, a: 255 }),
        _disabledColor: colorObj({ r: 124, g: 124, b: 124, a: 255 }),
        _normalSprite: null,
        _hoverSprite: null,
        _pressedSprite: null,
        _disabledSprite: null,
        _duration: 0.1,
        _zoomScale: 1.2,
        _target: { __id__: targetPrefabId ?? nodeId },
        _id: '',
      })
      objects.push({ __type__: 'cc.CompPrefabInfo', fileId: randomFileId() })
      compIds.push(btnId)
    }

    const pushBoundScript = (compName: string, extra: Record<string, unknown> = {}) => {
      const inst = node.components[compName]
      if (!inst) return
      const uuid = resolveSimpleListScriptUuid(inst, defs[compName])
      if (!uuid) {
        console.warn(
          `[cocosPrefab] ${compName} 缺少 scriptUuid（请设置 scriptPath 以从 .meta 自动填充），已跳过脚本绑定`,
        )
        return
      }
      const scriptType = compressUuid(uuid)
      const sid = objects.length
      objects.push({
        __type__: scriptType,
        _name: '',
        _objFlags: 0,
        __editorExtras__: {},
        node: { __id__: nodeId },
        _enabled: true,
        __prefab: { __id__: sid + 1 },
        ...extra,
        _id: '',
      })
      objects.push({ __type__: 'cc.CompPrefabInfo', fileId: randomFileId() })
      compIds.push(sid)
    }
    const langSprite = node.components['LangSpriteComponent']
    if (langSprite) {
      const spriteInst = node.components['SpriteComponent']
      const framePath =
        typeof spriteInst?.framePath === 'string' ? spriteInst.framePath.trim() : ''
      const exportName = framePath ? framePathToExportName.get(framePath) : undefined
      const langKey = exportName
        ? exportName.replace(/\.[^.]+$/, '')
        : node.name.replace(/^Langi/i, '') || node.name
      pushBoundScript('LangSpriteComponent', {
        isShowSetBk: true,
        isOnLoad: true,
        _bundleName: prefabName,
        _langKey: langKey,
        _langPath: 'UI',
        _initLangKey: '',
      })
    }
    pushBoundScript('LangLabelComponent')

    // 根节点挂载配套 .ts 脚本（__type__ = 压缩后的 typescript UUID）
    if (parentId === null && scriptType) {
      const scriptId = objects.length
      objects.push({
        __type__: scriptType,
        _name: '',
        _objFlags: 0,
        __editorExtras__: {},
        node: { __id__: nodeId },
        _enabled: true,
        __prefab: { __id__: scriptId + 1 },
        _id: '',
      })
      objects.push({ __type__: 'cc.CompPrefabInfo', fileId: randomFileId() })
      compIds.push(scriptId)
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

  emitNode(root, null, null)
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
 * `{baseName}/UI/*`（LangSprite 节点图片在 `{baseName}/UI/zh/*`）
 * + `{baseName}/{baseName}.prefab` + `{baseName}.ts` + 各级 .meta
 */
export async function exportCocosPrefabCore(
  options: CocosPrefabExportCoreOptions,
): Promise<CocosPrefabExportResult> {
  const { root, readImageBytes, fs } = options
  const baseName = toExportBaseName(options.baseName)
  const jobs = collectImageExportJobs(root)
  const uniqueSources = [...new Set(jobs.map((j) => j.sourcePath))]
  const missing: string[] = []
  const usedNamesByDir = new Map<string, Set<string>>()
  const pathToUuid = new Map<string, string>()
  const pathToExportName = new Map<string, string>()
  const pathToBytes = new Map<string, Uint8Array>()
  const usedUuids = new Set<string>()
  /** 与 `.ts.meta` / Prefab 根脚本组件共用 */
  const scriptUuid = stableUuid(`cocos-ts:${baseName}`)

  const readN = uniqueSources.length
  const writeN = jobs.length
  // prepare + 读图 + 写目录 + 写图 + prefab + script + done
  const totalSteps = 1 + readN + 1 + writeN + 1 + 1 + 1
  const report = createExportProgressReporter('cocos', totalSteps, options.onProgress)

  await report('prepare', `准备导出「${baseName}」…`)

  for (let i = 0; i < uniqueSources.length; i++) {
    const path = uniqueSources[i]!
    await report('read-images', `读取图片（${i + 1}/${readN}）：${path}`)
    const bytes = await readImageBytes(path)
    if (!bytes) {
      missing.push(path)
      continue
    }
    pathToBytes.set(path, bytes)
  }

  if (missing.length) {
    throw new Error(`缺少图片资源：\n${missing.join('\n')}`)
  }

  const usedNames = (subdir: string): Set<string> => {
    let set = usedNamesByDir.get(subdir)
    if (!set) {
      set = new Set()
      usedNamesByDir.set(subdir, set)
    }
    return set
  }

  const hasZh = jobs.some((j) => j.subdir === 'UI/zh')

  await report('write-images', '写入目录元数据…')
  await fs.writeText(
    `${baseName}.meta`,
    `${JSON.stringify(buildDirectoryMeta(stableUuid(`cocos-dir:${baseName}`)), null, 2)}\n`,
  )
  await fs.writeText(
    `${baseName}/UI.meta`,
    `${JSON.stringify(buildDirectoryMeta(stableUuid(`cocos-dir:${baseName}/UI`), !hasZh), null, 2)}\n`,
  )

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!
    const bytes = pathToBytes.get(job.sourcePath)!
    const exportName = uniqueFileName(usedNames(job.subdir), job.sourcePath)
    const isZh = job.subdir === 'UI/zh'
    const uuid = stableUuid(imageUuidSeed(job.sourcePath, job.subdir), isZh ? 4 : 5)
    if (usedUuids.has(uuid)) {
      console.warn(`[cocosPrefab] 图片 UUID 冲突：${job.subdir}/${job.sourcePath} → ${uuid}`)
    }
    usedUuids.add(uuid)
    pathToUuid.set(job.sourcePath, uuid)
    pathToExportName.set(job.sourcePath, exportName)
    const { width, height } = readImageSizeFromBytes(bytes)
    const displayName = exportName.replace(/\.[^.]+$/, '')
    const fileExt = extForMeta(exportName)

    await report('write-images', `写出图片（${i + 1}/${writeN}）：${job.subdir}/${exportName}`)
    await fs.writeBinary(`${baseName}/${job.subdir}/${exportName}`, bytes)
    await fs.writeText(
      `${baseName}/${job.subdir}/${exportName}.meta`,
      `${JSON.stringify(buildImageMeta(uuid, displayName, width, height, fileExt, !isZh), null, 2)}\n`,
    )
  }

  if (hasZh) {
    await fs.writeText(
      `${baseName}/UI/zh.meta`,
      `${JSON.stringify(buildDirectoryMeta(stableUuid(`cocos-dir:${baseName}/UI/zh`), false), null, 2)}\n`,
    )
  }

  await report('write-prefab', `生成 Prefab：${baseName}.prefab`)
  const prefabObjects = buildPrefabObjects(
    root,
    pathToUuid,
    baseName,
    scriptUuid,
    options.componentDefs,
    pathToExportName,
  )
  await fs.writeText(
    `${baseName}/${baseName}.prefab`,
    `${JSON.stringify(prefabObjects, null, 2)}\n`,
  )
  await fs.writeText(
    `${baseName}/${baseName}.prefab.meta`,
    `${JSON.stringify(buildPrefabMeta(stableUuid(`cocos-prefab:${baseName}`), baseName, !hasZh), null, 2)}\n`,
  )

  await report('write-script', `写出配套脚本：${baseName}.ts`)
  const scriptSource = buildPrefabScriptSource(baseName, {
    templateType: readRootTemplateType(root),
    markdownByStem: options.codePreviewMarkdown,
    templateMd: options.scriptTemplateMd,
  })
  await fs.writeText(`${baseName}/${baseName}.ts`, scriptSource)
  await fs.writeText(
    `${baseName}/${baseName}.ts.meta`,
    `${JSON.stringify(buildTypescriptMeta(scriptUuid), null, 2)}\n`,
  )

  await report('done', '导出完成')

  return {
    baseName,
    prefabPath: `${baseName}/${baseName}.prefab`,
    imageCount: jobs.length,
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
  const baseName = toExportBaseName(options.baseName)
  const packDir = await getDirectoryHandleByPath(exportRoot, baseName, true)
  if (!packDir) throw new Error('无法创建导出目录')
  const uiDir = await getDirectoryHandleByPath(packDir, 'UI', true)
  if (!uiDir) throw new Error('无法创建 UI 目录')

  return exportCocosPrefabCore({
    baseName,
    root,
    componentDefs: options.componentDefs,
    onProgress: options.onProgress,
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
