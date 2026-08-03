/**
 * 编辑器侧节点工具：再导出纯核心 + Vite 捆绑的默认 components.json。
 * CLI 请直接 import `./uiNode`，避免 `import.meta.glob`。
 */
export {
  canAddComponent,
  cloneWithNewIds,
  createComponentData,
  createDefaultUIData,
  createNode,
  defaultValueForProp,
  findNodeById,
  findParentById,
  genId,
  normalizeUIData,
  parseComponentDefs,
  parseVec2,
  serializeForDisk,
} from './uiNode'

/**
 * 内置兜底组件库：当 `config/components.json` 不存在时使用。
 */
const FALLBACK_COMPONENTS_JSON = `{
  "OpacityComponent": {
    "properties": {
      "opacity": { "type": "number", "default": 1.0, "min": 0, "max": 1, "step": 0.05 }
    },
    "componentType": 2
  },
  "SpriteComponent": {
    "properties": {
      "framePath": { "type": "string", "default": "" },
      "color": { "type": "color", "default": "#FFFFFF" },
      "sizeMode": {
        "type": "enum",
        "default": "TRIMMED",
        "options": [
          { "label": "CUSTOM", "value": "CUSTOM" },
          { "label": "TRIMMED", "value": "TRIMMED" },
          { "label": "RAW", "value": "RAW" }
        ]
      },
      "type": {
        "type": "enum",
        "default": "SIMPLE",
        "options": [
          { "label": "SIMPLE", "value": "SIMPLE" },
          { "label": "SLICED", "value": "SLICED" },
          { "label": "TILED", "value": "TILED" },
          { "label": "FILLED", "value": "FILLED" }
        ]
      }
    },
    "componentType": 1
  }
}
`

/** 优先读取仓库内 config/components.json；文件不存在时回退到 FALLBACK */
const bundledConfigModules = import.meta.glob('../../config/components.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>

function resolveDefaultComponentsJson(): string {
  const bundled = Object.values(bundledConfigModules)[0]
  if (bundled && typeof bundled === 'object' && !Array.isArray(bundled)) {
    return `${JSON.stringify(bundled, null, 2)}\n`
  }
  return FALLBACK_COMPONENTS_JSON
}

/** 新建项目 / 项目缺少 components.json 时使用的默认组件库文本 */
export const DEFAULT_COMPONENTS_JSON = resolveDefaultComponentsJson()
