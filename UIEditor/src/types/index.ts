/** 节点树 UI 编辑器核心类型定义 */

/** 单个 UI 节点。基础空间属性强制内置，直接映射 PixiJS。 */
export interface UINode {
  /** 运行时唯一 id（仅内存使用，写盘时剥离） */
  _id: string
  name: string
  active: boolean
  /** 相对父节点的中心锚点坐标（画布中心为全局 (0,0)） */
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  /** 组件名 -> 属性键值 */
  components: Record<string, Record<string, unknown>>
  children: UINode[]
}

/** components.json 中支持的属性类型 */
export type PropType = 'string' | 'number' | 'boolean' | 'color' | 'v2'

export interface PropDef {
  type: PropType
  default?: unknown
  min?: number
  max?: number
  step?: number
}

export interface ComponentDef {
  properties: Record<string, PropDef>
  /** 可选前缀（新建节点命名等） */
  prefix?: string
  /**
   * 组件类别。同一节点上，相同 componentType 的组件只能挂载一个；
   * 未声明时仅按组件名去重。
   */
  componentType?: number
}

/** components.json 的整体结构 */
export type ComponentDefs = Record<string, ComponentDef>

/** 项目文件树条目 */
export interface FileEntry {
  name: string
  /** 项目相对路径，如 "ui/main.json" */
  path: string
  kind: 'file' | 'directory'
  handle: FileSystemFileHandle | FileSystemDirectoryHandle
  children?: FileEntry[]
}

/** 资源管理器中的图片资产 */
export interface AssetEntry {
  name: string
  /** 项目相对路径 */
  path: string
  /** 缩略图 blob URL */
  url: string
}

export interface Vec2 {
  x: number
  y: number
}

export type Orientation = 'landscape' | 'portrait'
