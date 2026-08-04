/**
 * 从 codePreview/cocosPrefab.md 加载脚本模板，并将 FileName 替换为导出界面名。
 * 浏览器：Vite glob；CLI：可传入 md 文本，否则用内置兜底（与 md 同步）。
 */

/** 与 codePreview/cocosPrefab.md 同步的兜底模板 */
const EMBEDDED_MD = `\`\`\`ts
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

function tryViteGlob(): string | null {
  try {
    // UIEditor/src/utils → 仓库根 codePreview/
    const mods = import.meta.glob('../../../codePreview/cocosPrefab.md', {
      eager: true,
      query: '?raw',
      import: 'default',
    }) as Record<string, string>
    const text = Object.values(mods)[0]
    return typeof text === 'string' && text.includes('FileName') ? text : null
  } catch {
    return null
  }
}

export function loadCocosPrefabTemplateMd(overrideMd?: string): string {
  if (overrideMd && overrideMd.includes('FileName')) return overrideMd
  return tryViteGlob() ?? EMBEDDED_MD
}

/** 取出 markdown 中第一个 ts 代码块 */
export function extractTsFromMarkdown(md: string): string {
  const match = md.match(/```(?:ts|typescript)\s*\r?\n([\s\S]*?)```/i)
  if (!match?.[1]) {
    throw new Error('codePreview/cocosPrefab.md 中未找到 ```ts 代码块')
  }
  return `${match[1].replace(/\s+$/, '')}\n`
}

/** 合法 TS / Cocos 类名（替换模板中的 FileName） */
export function toPrefabScriptClassName(baseName: string): string {
  let s = baseName.replace(/[^a-zA-Z0-9_]/g, '_')
  if (!s) s = 'UIPrefab'
  if (/^[0-9]/.test(s)) s = `UI_${s}`
  return s
}

/** 生成挂到 Prefab 旁的脚本源码 */
export function buildPrefabScriptSource(baseName: string, templateMd?: string): string {
  const className = toPrefabScriptClassName(baseName)
  return extractTsFromMarkdown(loadCocosPrefabTemplateMd(templateMd)).replaceAll(
    'FileName',
    className,
  )
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
