import type { ComponentDef, ComponentDefs, PropDef, UINode, Vec2 } from '../types'

let idCounter = 0

export function genId(): string {
  idCounter += 1
  return `n_${Date.now().toString(36)}_${idCounter}`
}

/** 创建一个带基础属性的新节点 */
export function createNode(name: string, zIndex = 0): UINode {
  return {
    _id: genId(),
    name,
    active: true,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex,
    components: {},
    children: [],
  }
}

/** 新建 UI 界面时的最小合法结构：有且仅有一个根节点 */
export function createDefaultUIData(): UINode {
  const root = createNode('Root')
  root.width = 960
  root.height = 640
  return root
}

/**
 * 规范化从磁盘读入的任意 JSON：补齐基础属性、递归生成运行时 _id。
 * 返回 null 表示不是合法的节点结构。
 */
export function normalizeUIData(raw: unknown): UINode | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.name !== 'string') return null

  const normalizeChild = (value: unknown, index: number): UINode | null => {
    const node = normalizeUIData(value)
    if (node && typeof (value as Record<string, unknown>).zIndex !== 'number') {
      node.zIndex = index
    }
    return node
  }

  const childrenRaw = Array.isArray(obj.children) ? obj.children : []
  const children = childrenRaw
    .map((c, i) => normalizeChild(c, i))
    .filter((c): c is UINode => c !== null)

  return {
    _id: genId(),
    name: obj.name,
    active: typeof obj.active === 'boolean' ? obj.active : true,
    x: typeof obj.x === 'number' ? obj.x : 0,
    y: typeof obj.y === 'number' ? obj.y : 0,
    width: typeof obj.width === 'number' ? obj.width : 100,
    height: typeof obj.height === 'number' ? obj.height : 100,
    zIndex: typeof obj.zIndex === 'number' ? obj.zIndex : 0,
    components:
      typeof obj.components === 'object' && obj.components !== null && !Array.isArray(obj.components)
        ? (JSON.parse(JSON.stringify(obj.components)) as UINode['components'])
        : {},
    children,
  }
}

/** 序列化为写盘 JSON（剥离运行时 _id） */
export function serializeForDisk(root: UINode): string {
  return JSON.stringify(root, (key, value) => (key === '_id' ? undefined : value), 2)
}

export function findNodeById(root: UINode | null, id: string | null): UINode | null {
  if (!root || !id) return null
  if (root._id === id) return root
  for (const child of root.children) {
    const found = findNodeById(child, id)
    if (found) return found
  }
  return null
}

export function findParentById(root: UINode | null, id: string | null): UINode | null {
  if (!root || !id || root._id === id) return null
  for (const child of root.children) {
    if (child._id === id) return root
    const found = findParentById(child, id)
    if (found) return found
  }
  return null
}

/** 深拷贝节点并为整棵子树重新生成 _id（用于复制节点） */
export function cloneWithNewIds(node: UINode): UINode {
  const copy: UINode = JSON.parse(JSON.stringify(node))
  const walk = (n: UINode) => {
    n._id = genId()
    n.children.forEach(walk)
  }
  walk(copy)
  return copy
}

/** 解析 v2 默认值，支持 "(100,50)" 字符串或 {x,y} 对象 */
export function parseVec2(value: unknown): Vec2 {
  if (typeof value === 'string') {
    const match = value.match(/\(?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)?/)
    if (match) return { x: Number(match[1]), y: Number(match[2]) }
  }
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    return {
      x: typeof v.x === 'number' ? v.x : typeof v.w === 'number' ? v.w : 0,
      y: typeof v.y === 'number' ? v.y : typeof v.h === 'number' ? v.h : 0,
    }
  }
  return { x: 0, y: 0 }
}

export function defaultValueForProp(def: PropDef): unknown {
  switch (def.type) {
    case 'string':
      return typeof def.default === 'string' ? def.default : ''
    case 'number':
      return typeof def.default === 'number' ? def.default : 0
    case 'boolean':
      return typeof def.default === 'boolean' ? def.default : false
    case 'color':
      return typeof def.default === 'string' ? def.default : '#FFFFFF'
    case 'v2':
      return parseVec2(def.default)
    default:
      return def.default ?? null
  }
}

/** 根据组件定义生成带默认值的组件数据 */
export function createComponentData(def: ComponentDef): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const [key, propDef] of Object.entries(def.properties ?? {})) {
    data[key] = defaultValueForProp(propDef)
  }
  return data
}

/** 校验 components.json 文本合法性，返回解析结果或抛出错误信息 */
export function parseComponentDefs(text: string): ComponentDefs {
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('组件库必须是一个 JSON 对象')
  }
  for (const [name, def] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof def !== 'object' || def === null) {
      throw new Error(`组件 "${name}" 的定义必须是对象`)
    }
    const properties = (def as Record<string, unknown>).properties
    if (typeof properties !== 'object' || properties === null) {
      throw new Error(`组件 "${name}" 缺少 properties 字段`)
    }
    for (const [propName, propDef] of Object.entries(properties as Record<string, unknown>)) {
      const type = (propDef as Record<string, unknown>)?.type
      if (typeof type !== 'string') {
        throw new Error(`组件 "${name}" 的属性 "${propName}" 缺少 type 字段`)
      }
    }
  }
  return parsed as ComponentDefs
}

export const DEFAULT_COMPONENTS_JSON = `{
  "UIComponent": {
    "properties": {
      "size": { "type": "v2", "default": "(100,50)" },
      "anchor": { "type": "v2", "default": "(0.5,0.5)" }
    }
  },
  "OpacityComponent": {
    "properties": {
      "opacity": { "type": "number", "default": 1.0, "min": 0, "max": 1, "step": 0.05 }
    }
  },
  "SpriteComponent": {
    "properties": {
      "framePath": { "type": "string", "default": "" },
      "color": { "type": "color", "default": "#FFFFFF" },
      "sizeMode": { "type": "number", "default": 2 },
      "type": { "type": "number", "default": 1 }
    }
  }
}
`
