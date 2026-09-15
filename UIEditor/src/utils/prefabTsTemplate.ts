/**
 * 从 codePreview/*.md 按标题取出 ts 模板，并将 FileName 替换为导出界面名。
 * 浏览器：Vite glob；CLI：注入 markdownByStem，否则用内置兜底（与 cocosPrefab.md ### 1 同步）。
 */
import type { UINode } from '../types'
import { toExportBaseName } from './imageFileName'

/** 与 codePreview/cocosPrefab.md 的 ### 1 同步的兜底模板 */
const EMBEDDED_MD = `### 1
\`\`\`ts
import { _decorator, Node } from "cc";
import { BaseComponent, BindUI } from "lsscript";
const { ccclass } = _decorator;

@ccclass("FileName")
class FileName extends BaseComponent {
    private _bindUI: BindUI;

    public setInit(args: {parent:Node}): void {
        this._setInit(args.parent);
        
    }

    protected _initView(): void {
        this._bindUI = this._getUI(this.node);
    }

    protected _initEvent(): void {
        if(this._bindUI.Btn("BtnClose")){
            this._addClick(this._bindUI.Btn("BtnClose"), this.NodeDestroy);
        }
    }

    protected _destroyBefore(): void {

    }
}

\`\`\`
`

const STEM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface PrefabTemplateRef {
  /** codePreview/{fileStem}.md，缺省 cocosPrefab */
  fileStem: string
  /** 文档内 ### 标题，缺省 1 */
  heading: string
}

export interface BuildPrefabScriptOptions {
  /** Root.TemplateComponent.templateType */
  templateType?: string
  /**
   * 若已读到 templatePath 指向的 .md 正文：templateType 整串作为该文档内 ### 标题
   *（`xxx_aaa` → `### xxx_aaa`，不按下划线拆成 codePreview/xxx.md）。
   */
  sourceMd?: string
  /** CLI 注入的 stem → markdown 原文 */
  markdownByStem?: Record<string, string>
  /** 覆盖 cocosPrefab.md（兼容旧 CLI） */
  templateMd?: string
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 空 → cocosPrefab / 1；无下划线 → cocosPrefab / 该字符串；`xxx_aaa` → xxx.md / ### aaa */
export function parseTemplateType(raw: unknown): PrefabTemplateRef {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return { fileStem: 'cocosPrefab', heading: '1' }
  if (/[/\\]/.test(s)) throw new Error(`非法模板类型：${s}`)
  const idx = s.indexOf('_')
  if (idx === -1) return { fileStem: 'cocosPrefab', heading: s }
  const fileStem = s.slice(0, idx).trim()
  const heading = s.slice(idx + 1).trim()
  if (!fileStem || !heading) {
    throw new Error(`模板类型须为「标题」或「文件_标题」，收到：${s}`)
  }
  if (!STEM_RE.test(fileStem) || fileStem.includes('..')) {
    throw new Error(`非法模板文件名：${fileStem}`)
  }
  return { fileStem, heading }
}

export function readRootTemplateType(root: UINode): string {
  const raw = root.components['TemplateComponent']?.templateType
  return typeof raw === 'string' ? raw.trim() : ''
}

export function readRootTemplatePath(root: UINode): string {
  const raw = root.components['TemplateComponent']?.templatePath
  return typeof raw === 'string' ? raw.trim().replace(/\\/g, '/') : ''
}

export function isRemoteTemplateUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw.trim())
}

/** 本地 .md，或 http(s) 且 pathname 以 .md 结尾（忽略 query/hash） */
export function isMarkdownTemplatePath(p: string): boolean {
  const s = p.trim()
  if (!s) return false
  if (isRemoteTemplateUrl(s)) {
    try {
      const u = new URL(s)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
      return u.pathname.toLowerCase().endsWith('.md')
    } catch {
      return false
    }
  }
  const noQuery = s.split('?')[0]?.split('#')[0] ?? s
  return noQuery.toLowerCase().replace(/\\/g, '/').endsWith('.md')
}

function loadVitePreviewMarkdown(): Record<string, string> {
  try {
    const mods = import.meta.glob('../../../codePreview/*.md', {
      eager: true,
      query: '?raw',
      import: 'default',
    }) as Record<string, string>
    const out: Record<string, string> = {}
    for (const [p, text] of Object.entries(mods)) {
      if (typeof text !== 'string') continue
      const base = p.split('/').pop()?.replace(/\.md$/i, '')
      if (base) out[base] = text
    }
    return out
  } catch {
    return {}
  }
}

export function loadPreviewMarkdown(
  fileStem: string,
  options?: Pick<BuildPrefabScriptOptions, 'markdownByStem' | 'templateMd'>,
): string {
  if (fileStem === 'cocosPrefab' && options?.templateMd?.trim()) return options.templateMd
  const injected = options?.markdownByStem?.[fileStem]
  if (typeof injected === 'string' && injected.length) return injected
  const fromGlob = loadVitePreviewMarkdown()[fileStem]
  if (fromGlob) return fromGlob
  if (fileStem === 'cocosPrefab') return EMBEDDED_MD
  throw new Error(`找不到脚本模板文档：codePreview/${fileStem}.md`)
}

/** 取出 markdown 中第一个 ts 代码块（无标题时的兜底） */
export function extractTsFromMarkdown(md: string): string {
  const match = md.match(/```(?:ts|typescript)\s*\r?\n([\s\S]*?)```/i)
  if (!match?.[1]) {
    throw new Error('markdown 中未找到 ```ts 代码块')
  }
  return `${match[1].replace(/\s+$/, '')}\n`
}

/** 指定 ### 标题下的第一个 ts 代码块 */
export function extractTsBlockByHeading(md: string, heading: string): string {
  const lines = md.split(/\r?\n/)
  const headingRe = new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`)
  for (let i = 0; i < lines.length; i++) {
    if (!headingRe.test(lines[i]!)) continue
    const rest = lines.slice(i + 1).join('\n')
    const match = rest.match(/```(?:ts|typescript)\s*\r?\n([\s\S]*?)```/i)
    if (match?.[1]) return `${match[1].replace(/\s+$/, '')}\n`
    throw new Error(`标题「${heading}」下未找到 ts 代码块`)
  }
  throw new Error(`未找到标题 ### ${heading}`)
}

export function loadCocosPrefabTemplateMd(overrideMd?: string): string {
  return loadPreviewMarkdown('cocosPrefab', { templateMd: overrideMd })
}

function resolveTemplateTs(options?: BuildPrefabScriptOptions): string {
  if (options?.sourceMd?.trim()) {
    // 有 templatePath：标题 = templateType 原样（空 → 1）；禁止 xxx_aaa 拆文件
    const heading = (options.templateType ?? '').trim() || '1'
    return extractTsBlockByHeading(options.sourceMd, heading)
  }
  const ref = parseTemplateType(options?.templateType)
  const md = loadPreviewMarkdown(ref.fileStem, options)
  return extractTsBlockByHeading(md, ref.heading)
}

/** 合法 TS / Cocos 类名（替换模板中的 FileName）；与包标识名同一串（§6.1） */
export function toPrefabScriptClassName(baseName: string): string {
  let s = toExportBaseName(baseName).replace(/[^a-zA-Z0-9_]/g, '_')
  if (!s) s = 'UIPrefab'
  if (/^[0-9]/.test(s)) s = `UI${s}`
  return s
}

/** 生成挂到 Prefab 旁的脚本源码 */
export function buildPrefabScriptSource(
  baseName: string,
  templateMdOrOptions?: string | BuildPrefabScriptOptions,
): string {
  const options: BuildPrefabScriptOptions =
    typeof templateMdOrOptions === 'string'
      ? { templateMd: templateMdOrOptions }
      : (templateMdOrOptions ?? {})
  const className = toPrefabScriptClassName(baseName)
  return resolveTemplateTs(options).replaceAll('FileName', className)
}

/** Creator 3.8 typescript 资源 .meta */
export function buildTypescriptMeta(uuid: string): Record<string, unknown> {
  return {
    ver: '4.0.24',
    importer: 'typescript',
    imported: true,
    uuid,
    files: [],
    subMetas: {},
    userData: {},
  }
}
