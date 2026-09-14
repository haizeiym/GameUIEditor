/**
 * 导出 PNG/JPG 文件名：含汉字则转拼音首字母；碰撞加数字后缀。
 */
import { pinyin } from 'pinyin-pro'
import { sanitizeFsName } from './fsName'

const CJK_RE = /[\u4e00-\u9fff]/
const EXT_RE = /\.(png|jpg|jpeg|webp)$/i
const SAFE_RE = /[^A-Za-z0-9._-]/g

/** 去掉扩展名后的 stem；含汉字则拼音首字母缩写（小写）；无汉字沿用 sanitizeFsName */
export function toImageFileStem(rawName: string): string {
  const noExt = rawName.replace(EXT_RE, '').trim()
  if (CJK_RE.test(noExt)) {
    const abbr = pinyin(noExt, {
      pattern: 'first',
      toneType: 'none',
      type: 'string',
      nonZh: 'consecutive',
      v: true,
    }).replace(/\s+/g, '')
    const safe = sanitizeFsName(abbr).replace(SAFE_RE, '_')
    return (safe || 'img').toLowerCase()
  }
  return sanitizeFsName(noExt)
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
