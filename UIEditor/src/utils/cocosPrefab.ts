/**
 * 将编辑器 UI JSON 导出为 Cocos Creator 3.8.x Prefab 资源包
 *（含图片、目录/资源 .meta、Prefab 内 SpriteFrame UUID 引用）。
 */
import type { ComponentDef, ComponentDefs, UINode } from '../types'
import {
  createExportProgressReporter,
  type OnExportProgress,
} from './exportProgress'
import { downloadTextWithProgress, formatByteSize } from './downloadText'
import {
  getDirectoryHandleByPath,
  getFileHandleByPath,
  writeBinaryFile,
  writeTextFile,
} from './fs'
import { sanitizeFsName } from './fsName'
import { uniqueImageFileName, stripParentheticals } from './imageFileName'
import { readImagePathList } from './imagePaths'
import {
  buildPrefabScriptSource,
  buildTypescriptMeta,
  collectChildTemplateJobs,
  isMarkdownTemplatePath,
  isRemoteTemplateUrl,
  readRootTemplatePath,
  readRootTemplateType,
  resolvePrefabPackName,
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
  /** 读取 templatePath 指向的本地 .md（绝对路径或项目相对路径）；远程 http(s) 由核心自行下载 */
  readText?: (path: string) => Promise<string | null>
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
  /** 读取 templatePath（本地路径）；远程 URL 由核心下载 */
  readText?: (path: string) => Promise<string | null>
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

/** Prefab `_name`：去掉半角/全角括号及其中内容，不回写 JSON */
function exportNodeName(node: UINode): string {
  return stripParentheticals(node.name || '') || 'Node'
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
  if (nodeNameStartsWithBtn(exportNodeName(node))) {
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

/** 相对包根的图片目录，如 `UI` / `UI/zh` / `UI/img` */
export type SpriteExportSubdir = string

export interface ImageExportJob {
  sourcePath: string
  subdir: SpriteExportSubdir
}

export function imageJobKey(sourcePath: string, subdir: string): string {
  return `${subdir}\0${sourcePath}`
}

function readSpriteFramePath(node: UINode): string {
  const sprite = node.components['SpriteComponent']
  return typeof sprite?.framePath === 'string' ? sprite.framePath.trim() : ''
}

/**
 * `toFile` → `UI/{seg}/…`。空、`UI`、含 `..` 视为无效（导出不改目录）。
 * 不要写 `UI/` 前缀；`img` → `UI/img`。每段走 sanitizeFsName。
 */
export function normalizeToFileSubdir(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim().replace(/\\/g, '/')
  if (!s) return null
  s = s.replace(/^\/+/, '')
  if (/^UI$/i.test(s)) return null
  if (/^UI\//i.test(s)) s = s.slice(s.indexOf('/') + 1)
  const parts = s.split('/').filter(Boolean)
  if (parts.length === 0) return null
  const safe: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '..') {
      console.warn(`[cocosPrefab] ImgToFile.toFile 含非法路径段「${part}」，已忽略`)
      return null
    }
    safe.push(sanitizeFsName(part))
  }
  return `UI/${safe.join('/')}`
}

/** LangSprite 优先 UI/zh；否则 ImgToFile.toFile 非空 → UI/{toFile}；否则 UI/ */
export function resolveSpriteExportSubdir(node: UINode): SpriteExportSubdir {
  if (node.components['LangSpriteComponent']) return 'UI/zh'
  const inst = node.components['ImgToFileComponent']
  return normalizeToFileSubdir(inst?.toFile) ?? 'UI'
}

function addImageJob(
  byKey: Map<string, ImageExportJob>,
  sourcePath: string,
  subdir: SpriteExportSubdir,
) {
  const trimmed = sourcePath.trim().replace(/\\/g, '/')
  if (!trimmed) return
  const key = imageJobKey(trimmed, subdir)
  if (!byKey.has(key)) byKey.set(key, { sourcePath: trimmed, subdir })
}

/**
 * 每个 (路径, 导出目录) 一份。
 * Sprite.framePath：LangSprite → UI/zh；否则 ImgToFile.toFile 非空 → UI/{toFile}；否则 UI/。
 * ImgToFile.fileArray：仅当 toFile 有效时额外写入同一 UI/{toFile}（不受 LangSprite 影响）。
 */
export function collectImageExportJobs(root: UINode): ImageExportJob[] {
  const byKey = new Map<string, ImageExportJob>()
  const walk = (n: UINode) => {
    const trimmed = readSpriteFramePath(n)
    if (trimmed) addImageJob(byKey, trimmed, resolveSpriteExportSubdir(n))
    const inst = n.components['ImgToFileComponent']
    const extraDir = normalizeToFileSubdir(inst?.toFile)
    if (extraDir) {
      for (const p of readImagePathList(inst?.fileArray)) {
        addImageJob(byKey, p, extraDir)
      }
    }
    n.children.forEach(walk)
  }
  walk(root)
  return [...byKey.values()]
}

export function collectFramePaths(root: UINode): string[] {
  return [...new Set(collectImageExportJobs(root).map((j) => j.sourcePath))]
}

/** UI/ 保持原种子；其它子目录（zh / toFile）换种子，导出时 Prefab 按新 UUID 重绑 */
export function imageUuidSeed(sourcePath: string, subdir: SpriteExportSubdir): string {
  if (subdir === 'UI') return `cocos-image:${sourcePath}`
  return `cocos-image:${subdir}:${sourcePath}`
}

function isDefaultUiDir(subdir: string): boolean {
  return subdir === 'UI'
}

/** UI 之下需要单独写 .meta 的目录（不含 UI 自身），短路径在前 */
function extraDirMetaPaths(subdirs: string[]): string[] {
  const set = new Set<string>()
  for (const subdir of subdirs) {
    const parts = subdir.split('/').filter(Boolean)
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      if (acc !== 'UI') set.add(acc)
    }
  }
  return [...set].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  )
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

/** TRIMMED/RAW 必须与 SpriteFrame.rect/originalSize 一致，否则编辑器 `_resized` 会改成 CUSTOM */
function spriteUiContentSize(
  node: UINode,
  imageSizes: Map<string, { width: number; height: number }>,
): { width: number; height: number } {
  const fallback = {
    width: Math.max(0, Number(node.width) || 0),
    height: Math.max(0, Number(node.height) || 0),
  }
  const sprite = node.components['SpriteComponent']
  if (!sprite) return fallback
  const sizeMode = resolveSizeMode(sprite.sizeMode)
  if (sizeMode === SizeMode.CUSTOM) return fallback
  const framePath = typeof sprite.framePath === 'string' ? sprite.framePath.trim() : ''
  if (!framePath) return fallback
  const img = imageSizes.get(framePath)
  if (!img || img.width <= 0 || img.height <= 0) return fallback
  return { width: img.width, height: img.height }
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
  framePathToImageSize: Map<string, { width: number; height: number }> = new Map(),
  extraScriptByNodeId: Map<string, string> = new Map(),
): PrefabObject[] {
  const objects: PrefabObject[] = []
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
    const exportedName = exportNodeName(node)
    const nodeObj: PrefabObject = {
      __type__: 'cc.Node',
      _name: exportedName,
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
    const contentSize = spriteUiContentSize(node, framePathToImageSize)
    objects.push({
      __type__: 'cc.UITransform',
      _name: '',
      _objFlags: 0,
      __editorExtras__: {},
      node: { __id__: nodeId },
      _enabled: true,
      __prefab: { __id__: uitId + 1 },
      _contentSize: size(contentSize.width, contentSize.height),
      _anchorPoint: vec2(0.5, 0.5),
      _id: '',
    })
    objects.push({ __type__: 'cc.CompPrefabInfo', fileId: randomFileId() })
    compIds.push(uitId)

    // SimpleList 的 view 节点：自动挂 Mask（矩形裁剪）
    if (
      exportedName === 'view' &&
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
      const framePath = readSpriteFramePath(node)
      const spriteSubdir = resolveSpriteExportSubdir(node)
      /** 绑定本导出份的 UUID：进 UI/zh 或 toFile 子目录后已是新种子，与 .meta 一致 */
      const spriteUuid = framePath
        ? framePathToSpriteUuid.get(imageJobKey(framePath, spriteSubdir))
        : undefined
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
      const framePath = readSpriteFramePath(node)
      const exportName = framePath
        ? framePathToExportName.get(imageJobKey(framePath, resolveSpriteExportSubdir(node)))
        : undefined
      const langKey = exportName
        ? exportName.replace(/\.[^.]+$/, '')
        : exportedName.replace(/^Langi/i, '') || exportedName
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

    const attachTs = (uuid: string) => {
      const compressed = compressUuid(uuid)
      const sid = objects.length
      objects.push({
        __type__: compressed,
        _name: '',
        _objFlags: 0,
        __editorExtras__: {},
        node: { __id__: nodeId },
        _enabled: true,
        __prefab: { __id__: sid + 1 },
        _id: '',
      })
      objects.push({ __type__: 'cc.CompPrefabInfo', fileId: randomFileId() })
      compIds.push(sid)
    }

    // 根节点挂载配套 .ts 脚本（__type__ = 压缩后的 typescript UUID）
    if (parentId === null && scriptUuid) attachTs(scriptUuid)
    const extraUuid = extraScriptByNodeId.get(node._id)
    if (extraUuid && !(parentId === null && extraUuid === scriptUuid)) attachTs(extraUuid)

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
 * `{baseName}/UI/*`（LangSprite → `UI/zh`；ImgToFile.toFile=img → `UI/img`，含 fileArray）
 * + `{baseName}/{baseName}.prefab` + `{baseName}.ts` + 各级 .meta
 */
export async function exportCocosPrefabCore(
  options: CocosPrefabExportCoreOptions,
): Promise<CocosPrefabExportResult> {
  const { root, readImageBytes, fs } = options
  const baseName = resolvePrefabPackName(root, options.baseName)
  const jobs = collectImageExportJobs(root)
  const uniqueSources = [...new Set(jobs.map((j) => j.sourcePath))]
  const missing: string[] = []
  const usedNamesByDir = new Map<string, Set<string>>()
  const pathToUuid = new Map<string, string>()
  const pathToExportName = new Map<string, string>()
  const pathToBytes = new Map<string, Uint8Array>()
  const pathToImageSize = new Map<string, { width: number; height: number }>()
  const usedUuids = new Set<string>()
  /** 与 `.ts.meta` / Prefab 根脚本组件共用 */
  const scriptUuid = stableUuid(`cocos-ts:${baseName}`)
  const childJobs = collectChildTemplateJobs(root)
  const extraJobs = childJobs.filter((j) => j.fileStem !== baseName)
  const extraScriptByNodeId = new Map<string, string>()
  for (const job of childJobs) {
    const uuid =
      job.fileStem === baseName ? scriptUuid : stableUuid(`cocos-ts:${baseName}:${job.fileStem}`)
    for (const id of job.nodeIds) extraScriptByNodeId.set(id, uuid)
  }

  const templatePaths: string[] = []
  const seenTemplatePath = new Set<string>()
  const pushTemplatePath = (p: string) => {
    if (!p || seenTemplatePath.has(p)) return
    seenTemplatePath.add(p)
    templatePaths.push(p)
  }
  pushTemplatePath(readRootTemplatePath(root))
  for (const job of childJobs) pushTemplatePath(job.templatePath)
  for (const p of templatePaths) {
    if (!isMarkdownTemplatePath(p)) {
      throw new Error(`templatePath 必须指向 .md 文件或 https://…/*.md：${p}`)
    }
  }

  const readN = uniqueSources.length
  const writeN = jobs.length
  const remotes = templatePaths.filter((p) => isRemoteTemplateUrl(p))
  const downloadCap = remotes.length ? 100 : 0
  // （可选下载 100 格）+ prepare + 读图 + 写目录 + 写图 + prefab + pack script + extra scripts + done
  const totalSteps = downloadCap + 1 + readN + 1 + writeN + 1 + 1 + extraJobs.length + 1
  const report = createExportProgressReporter('cocos', totalSteps, options.onProgress)

  const mdByPath = new Map<string, string>()
  if (remotes.length) {
    for (let i = 0; i < remotes.length; i++) {
      const url = remotes[i]!
      const sliceStart = Math.floor((i * downloadCap) / remotes.length)
      const sliceEnd = Math.floor(((i + 1) * downloadCap) / remotes.length)
      const span = Math.max(1, sliceEnd - sliceStart)
      await report.set(
        Math.max(1, sliceStart + 1),
        'download-template',
        `开始下载模板：${url}`,
      )
      const text = await downloadTextWithProgress(url, async (loaded, totalBytes) => {
        const fraction =
          totalBytes && totalBytes > 0
            ? loaded / totalBytes
            : Math.min(0.99, loaded / (512 * 1024))
        const cur = Math.max(
          sliceStart + 1,
          Math.min(Math.max(sliceStart + 1, sliceEnd - 1), sliceStart + Math.round(fraction * span)),
        )
        const sizePart =
          totalBytes && totalBytes > 0
            ? `${formatByteSize(loaded)} / ${formatByteSize(totalBytes)}`
            : formatByteSize(loaded)
        const pct = Math.round(fraction * 100)
        await report.set(cur, 'download-template', `下载模板 ${pct}%（${sizePart}）`)
      })
      mdByPath.set(url, text)
    }
    await report.set(downloadCap, 'download-template', '模板下载完成')
  }
  for (const p of templatePaths) {
    if (isRemoteTemplateUrl(p)) continue
    if (!options.readText) {
      throw new Error(`无法读取模板文件（缺少 readText）：${p}`)
    }
    const text = await options.readText(p)
    if (text == null || !text.length) {
      throw new Error(`读不到模板文件：${p}`)
    }
    mdByPath.set(p, text)
  }
  const rootTemplatePath = readRootTemplatePath(root)
  const sourceMd = rootTemplatePath ? mdByPath.get(rootTemplatePath) : undefined

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

  const extraDirs = extraDirMetaPaths(jobs.map((j) => j.subdir))
  const hasExtra = extraDirs.length > 0

  await report('write-images', '写入目录元数据…')
  await fs.writeText(
    `${baseName}.meta`,
    `${JSON.stringify(buildDirectoryMeta(stableUuid(`cocos-dir:${baseName}`)), null, 2)}\n`,
  )
  await fs.writeText(
    `${baseName}/UI.meta`,
    `${JSON.stringify(buildDirectoryMeta(stableUuid(`cocos-dir:${baseName}/UI`), !hasExtra), null, 2)}\n`,
  )

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!
    const bytes = pathToBytes.get(job.sourcePath)!
    const exportName = uniqueFileName(usedNames(job.subdir), job.sourcePath)
    const extraDir = !isDefaultUiDir(job.subdir)
    const uuid = stableUuid(imageUuidSeed(job.sourcePath, job.subdir), extraDir ? 4 : 5)
    if (usedUuids.has(uuid)) {
      console.warn(`[cocosPrefab] 图片 UUID 冲突：${job.subdir}/${job.sourcePath} → ${uuid}`)
    }
    usedUuids.add(uuid)
    const key = imageJobKey(job.sourcePath, job.subdir)
    pathToUuid.set(key, uuid)
    pathToExportName.set(key, exportName)
    const { width, height } = readImageSizeFromBytes(bytes)
    pathToImageSize.set(job.sourcePath, { width, height })
    const displayName = exportName.replace(/\.[^.]+$/, '')
    const fileExt = extForMeta(exportName)

    await report('write-images', `写出图片（${i + 1}/${writeN}）：${job.subdir}/${exportName}`)
    await fs.writeBinary(`${baseName}/${job.subdir}/${exportName}`, bytes)
    await fs.writeText(
      `${baseName}/${job.subdir}/${exportName}.meta`,
      `${JSON.stringify(buildImageMeta(uuid, displayName, width, height, fileExt, !extraDir), null, 2)}\n`,
    )
  }

  for (const dir of extraDirs) {
    await fs.writeText(
      `${baseName}/${dir}.meta`,
      `${JSON.stringify(buildDirectoryMeta(stableUuid(`cocos-dir:${baseName}/${dir}`), false), null, 2)}\n`,
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
    pathToImageSize,
    extraScriptByNodeId,
  )
  await fs.writeText(
    `${baseName}/${baseName}.prefab`,
    `${JSON.stringify(prefabObjects, null, 2)}\n`,
  )
  await fs.writeText(
    `${baseName}/${baseName}.prefab.meta`,
    `${JSON.stringify(buildPrefabMeta(stableUuid(`cocos-prefab:${baseName}`), baseName, !hasExtra), null, 2)}\n`,
  )

  await report('write-script', `写出配套脚本：${baseName}.ts`)
  const scriptSource = buildPrefabScriptSource(baseName, {
    templateType: readRootTemplateType(root),
    sourceMd,
    markdownByStem: options.codePreviewMarkdown,
    templateMd: options.scriptTemplateMd,
  })
  await fs.writeText(`${baseName}/${baseName}.ts`, scriptSource)
  await fs.writeText(
    `${baseName}/${baseName}.ts.meta`,
    `${JSON.stringify(buildTypescriptMeta(scriptUuid), null, 2)}\n`,
  )

  for (const job of extraJobs) {
    await report('write-script', `写出子模板脚本：${job.fileStem}.ts`)
    const extraSource = buildPrefabScriptSource(job.fileStem, {
      templateType: job.templateType,
      sourceMd: job.templatePath ? mdByPath.get(job.templatePath) : undefined,
      markdownByStem: options.codePreviewMarkdown,
      templateMd: options.scriptTemplateMd,
    })
    const extraUuid = stableUuid(`cocos-ts:${baseName}:${job.fileStem}`)
    await fs.writeText(`${baseName}/${job.fileStem}.ts`, extraSource)
    await fs.writeText(
      `${baseName}/${job.fileStem}.ts.meta`,
      `${JSON.stringify(buildTypescriptMeta(extraUuid), null, 2)}\n`,
    )
  }

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
  const baseName = resolvePrefabPackName(root, options.baseName)
  const packDir = await getDirectoryHandleByPath(exportRoot, baseName, true)
  if (!packDir) throw new Error('无法创建导出目录')
  const uiDir = await getDirectoryHandleByPath(packDir, 'UI', true)
  if (!uiDir) throw new Error('无法创建 UI 目录')

  return exportCocosPrefabCore({
    baseName,
    root,
    componentDefs: options.componentDefs,
    onProgress: options.onProgress,
    readText: options.readText,
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
