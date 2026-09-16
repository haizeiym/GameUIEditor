/**
 * 含汉字的写盘名：图片用拼音首字母；Prefab 包名用全拼大驼峰。
 */
import { pinyin } from 'pinyin-pro'
import { sanitizeFsName } from './fsName'

const CJK_RE = /[\u4e00-\u9fff]/
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp)$/i
const PACK_EXT_RE = /\.(json|prefab|ts)$/i
const SAFE_RE = /[^A-Za-z0-9._-]/g
const ODD_TRAIL_RE = /[._-]+$/

function stripExt(rawName: string, extRe: RegExp): string {
  return rawName.replace(extRe, '').trim()
}

/** 去掉半角 `()`、全角 `（）` 及其中内容（嵌套则反复剥） */
export function stripParentheticals(raw: string): string {
  let s = raw
  for (;;) {
    const next = s.replace(/\([^()]*\)/g, '').replace(/（[^（）]*）/g, '')
    if (next === s) break
    s = next
  }
  return s.replace(/\s+/g, ' ').trim()
}

/** 原名不含 `_` 时去掉结尾的 `_` `.` `-`（转换引入的奇怪符号） */
function stripTrailingOddSymbols(stem: string, originalNoExt: string): string {
  if (originalNoExt.includes('_')) return stem
  return stem.replace(ODD_TRAIL_RE, '')
}

function finalizeStem(stem: string, originalNoExt: string, emptyFallback: string): string {
  return stripTrailingOddSymbols(stem, originalNoExt) || emptyFallback
}

/** 去掉扩展名后的 stem：先去括号，含汉字则拼音首字母缩写（小写）；无汉字沿用 sanitizeFsName */
export function toImageFileStem(rawName: string): string {
  const rawNoExt = stripExt(rawName, IMAGE_EXT_RE)
  const noExt = stripParentheticals(rawNoExt)
  if (!noExt) return CJK_RE.test(rawNoExt) ? 'img' : 'untitled'
  if (CJK_RE.test(noExt)) {
    const abbr = pinyin(noExt, {
      pattern: 'first',
      toneType: 'none',
      type: 'string',
      nonZh: 'consecutive',
      v: true,
    }).replace(/\s+/g, '')
    const safe = sanitizeFsName(abbr).replace(SAFE_RE, '_').toLowerCase()
    return finalizeStem(safe, noExt, 'img')
  }
  return finalizeStem(sanitizeFsName(noExt), noExt, 'untitled')
}

/**
 * Prefab 导出包标识：文件夹 / prefab / 脚本文件名 / 类名同一串。
 * 含汉字 → 全拼大驼峰；无汉字 → sanitizeFsName。
 */
export function toExportBaseName(rawName: string): string {
  const noExt = stripExt(rawName, PACK_EXT_RE)
  if (!CJK_RE.test(noExt)) {
    return finalizeStem(sanitizeFsName(noExt), noExt, 'ui')
  }

  const parts = pinyin(noExt, {
    toneType: 'none',
    type: 'array',
    nonZh: 'consecutive',
    v: true,
  })
  const tokens = (Array.isArray(parts) ? parts : String(parts).split(/\s+/))
    .map((part) => part.replace(/[^A-Za-z0-9]/g, ''))
    .filter((part) => part.length > 0)
  const ident = tokens
    .map((t) => `${t.charAt(0).toUpperCase()}${t.slice(1).toLowerCase()}`)
    .join('')
  let safe = finalizeStem(ident, noExt, 'ui')
  if (/^[0-9]/.test(safe)) safe = `UI${safe}`
  return safe || 'ui'
}

/**
 * 生成不冲突的图片文件名（大小写不敏感）。
 * @param used 已占用的小写文件名集合（本函数会写入）
 * @param rawName 图层名或原文件名
 * @param ext 含点扩展名，默认 `.png`
 */
export function uniqueImageFileName(used: Set<string>, rawName: string, ext = '.png'): string {
  const stem = toImageFileStem(rawName)
  const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`
  let candidate = `${stem}${normalizedExt}`
  let i = 1
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem}_${i++}${normalizedExt}`
  }
  used.add(candidate.toLowerCase())
  return candidate
}
