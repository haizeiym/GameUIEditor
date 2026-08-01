<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Application,
  Container,
  Graphics,
  NineSliceSprite,
  Point,
  Rectangle,
  Sprite,
  Texture,
  TilingSprite,
  type FederatedPointerEvent,
} from 'pixi.js'

/** 对齐 Cocos Sprite.SizeMode（JSON 存 label 名） */
const SizeMode = { CUSTOM: 0, TRIMMED: 1, RAW: 2 } as const
/** 对齐 Cocos Sprite.Type（JSON 存 label 名） */
const SpriteType = { SIMPLE: 0, SLICED: 1, TILED: 2, FILLED: 3 } as const

function resolveSizeMode(v: unknown): number {
  if (typeof v === 'string') {
    const key = v.toUpperCase() as keyof typeof SizeMode
    if (key in SizeMode) return SizeMode[key]
  }
  if (typeof v === 'number' && v >= 0 && v <= 2) return v
  // 与 components.json 默认 TRIMMED 一致
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
import type { UINode } from '../types'
import { useEditorStore } from '../stores/editor'
import { useProjectStore } from '../stores/project'
import { findNodeById } from '../utils/node'

const editor = useEditorStore()
const project = useProjectStore()
const wrapEl = ref<HTMLDivElement>()

let app: Application | null = null
let world: Container | null = null
let frameG: Graphics | null = null
let selectionG: Graphics | null = null
let handlesLayer: Container | null = null
let handles: Graphics[] = []
let destroyed = false
/** 用户是否已手动平移/缩放；为 true 时 resize 不再强制回中 */
let userAdjustedView = false
let resizeObserver: ResizeObserver | null = null

const HANDLE_CURSORS = ['nwse-resize', 'nesw-resize', 'nesw-resize', 'nwse-resize'] as const

const idMap = new Map<string, Container>()
const textureCache = new Map<string, Promise<Texture | null>>()

/** 复用点，避免每次命中分配 */
const _local = new Point()
const _stagePt = new Point()
const _corner = new Point()

// ---------- 纹理加载 ----------

function loadTexture(path: string): Promise<Texture | null> {
  let cached = textureCache.get(path)
  if (!cached) {
    cached = (async () => {
      try {
        const file = await project.getFileByPath(path)
        if (!file) return null
        const bitmap = await createImageBitmap(file)
        return Texture.from(bitmap)
      } catch {
        return null
      }
    })()
    textureCache.set(path, cached)
  }
  return cached
}

/** 按 sizeMode 决定显示宽高（CUSTOM=节点尺寸，TRIMMED/RAW=贴图尺寸） */
function resolveSpriteSize(
  node: UINode,
  texture: Texture,
  sizeMode: number,
): { w: number; h: number } {
  if (sizeMode === SizeMode.TRIMMED) {
    return {
      w: Math.max(1, texture.frame?.width ?? texture.width),
      h: Math.max(1, texture.frame?.height ?? texture.height),
    }
  }
  if (sizeMode === SizeMode.RAW) {
    const src = texture.source
    return {
      w: Math.max(1, src?.width ?? texture.width),
      h: Math.max(1, src?.height ?? texture.height),
    }
  }
  return { w: Math.max(1, node.width), h: Math.max(1, node.height) }
}

function applySpriteVisualSize(
  display: Sprite | NineSliceSprite | TilingSprite,
  node: UINode,
  texture: Texture,
  sizeMode: number,
) {
  const { w, h } = resolveSpriteSize(node, texture, sizeMode)
  display.width = w
  display.height = h
}

function toTint(color: unknown): number {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}/.test(color)) {
    return parseInt(color.slice(1, 7), 16)
  }
  if (Array.isArray(color) && color.length >= 3) {
    const [r, g, b] = color as number[]
    return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255)
  }
  return 0xffffff
}

function localRect(w: number, h: number) {
  return { x: -w / 2, y: -h / 2, w, h }
}

// ---------- 场景构建（中心锚点；画布中心 = 全局 (0,0)） ----------

function buildNode(node: UINode): Container {
  const c = new Container()
  c.label = node._id
  c.position.set(node.x, node.y)
  c.visible = node.active
  // 同级绘制顺序只跟 children / addChild 顺序走，不按 zIndex 重排
  c.sortableChildren = false
  // 禁用 Pixi 自带交互，统一走舞台级精确命中
  c.eventMode = 'none'
  c.interactiveChildren = false
  const lr = localRect(node.width, node.height)
  idMap.set(node._id, c)

  const opacityComp = node.components['OpacityComponent']
  if (opacityComp && typeof opacityComp.opacity === 'number') {
    c.alpha = Math.min(Math.max(opacityComp.opacity, 0), 1)
  }

  const spriteComp = node.components['SpriteComponent']
  const framePath = typeof spriteComp?.framePath === 'string' ? spriteComp.framePath : ''
  if (spriteComp && framePath) {
    const sizeMode = resolveSizeMode(spriteComp.sizeMode)
    const spriteType = resolveSpriteType(spriteComp.type)
    const tint = toTint(spriteComp.color)

    // 占位，贴图加载后再按 type 换成 NineSlice / Tiling
    const placeholder = new Sprite(Texture.EMPTY)
    placeholder.label = '__self'
    placeholder.eventMode = 'none'
    placeholder.anchor.set(0.5)
    placeholder.tint = tint
    placeholder.width = Math.max(1, node.width)
    placeholder.height = Math.max(1, node.height)
    c.addChild(placeholder)

    void loadTexture(framePath).then((texture) => {
      if (!texture || c.destroyed) return
      const parent = placeholder.parent
      if (!parent) return
      const idx = parent.getChildIndex(placeholder)
      placeholder.destroy()

      let display: Sprite | NineSliceSprite | TilingSprite
      if (spriteType === SpriteType.SLICED) {
        const tw = Math.max(1, texture.width)
        const th = Math.max(1, texture.height)
        display = new NineSliceSprite({
          texture,
          leftWidth: tw / 3,
          topHeight: th / 3,
          rightWidth: tw / 3,
          bottomHeight: th / 3,
        })
        display.anchor.set(0.5)
      } else if (spriteType === SpriteType.TILED) {
        const { w, h } = resolveSpriteSize(node, texture, sizeMode)
        display = new TilingSprite({ texture, width: w, height: h })
        display.anchor.set(0.5)
      } else {
        // SIMPLE / FILLED（编辑器预览：FILLED 暂按 SIMPLE 拉伸）
        display = new Sprite(texture)
        display.anchor.set(0.5)
      }
      display.label = '__self'
      display.eventMode = 'none'
      display.tint = tint
      applySpriteVisualSize(display, node, texture, sizeMode)
      parent.addChildAt(display, idx)
    })
  } else {
    const g = new Graphics()
      .rect(lr.x, lr.y, node.width, node.height)
      .fill({ color: 0x4a90d9, alpha: 0.07 })
      .stroke({ color: 0x8899aa, width: 1, alpha: 0.35 })
    g.label = '__self'
    g.eventMode = 'none'
    c.addChild(g)
  }

  // 按 children 顺序 addChild：先出现的在下，后出现的在上（与 PSD 自下而上创建一致）
  c.interactiveChildren = true
  for (const child of node.children) {
    c.addChild(buildNode(child))
  }
  return c
}

let rebuildQueued = false
function queueRebuild() {
  if (rebuildQueued) return
  rebuildQueued = true
  requestAnimationFrame(() => {
    rebuildQueued = false
    rebuild()
  })
}

function updateDesignFrame() {
  if (!frameG) return
  const w = editor.canvasWidth
  const h = editor.canvasHeight
  frameG.clear()
  frameG
    .rect(-w / 2, -h / 2, w, h)
    .fill({ color: 0x1c1c1f, alpha: 0.55 })
    .stroke({ color: 0x52525b, width: 1 })
  // 中心十字准星（设计坐标原点）
  frameG.moveTo(-16, 0).lineTo(16, 0).stroke({ color: 0x94a3b8, width: 1, alpha: 0.85 })
  frameG.moveTo(0, -16).lineTo(0, 16).stroke({ color: 0x94a3b8, width: 1, alpha: 0.85 })
  frameG.circle(0, 0, 3).fill({ color: 0x94a3b8, alpha: 0.9 })
}

/** 将设计原点 (0,0) 与十字准星置于中间画布视口正中央 */
function centerWorldView(force = false) {
  if (!app || !world) return
  if (userAdjustedView && !force) return
  world.scale.set(1)
  world.position.set(Math.round(app.screen.width / 2), Math.round(app.screen.height / 2))
  userAdjustedView = false
}

function rebuild() {
  if (!app || !world || dragging || resizing) return
  for (const child of world.children.slice()) {
    if (child === frameG) continue
    world.removeChild(child)
    child.destroy({ children: true })
  }
  idMap.clear()
  updateDesignFrame()
  const data = editor.currentUIData
  if (!data) return
  world.addChild(buildNode(data as UINode))
}

function syncNodeVisual(c: Container, node: UINode) {
  c.position.set(node.x, node.y)
  const lr = localRect(node.width, node.height)
  const spriteComp = node.components['SpriteComponent']
  const sizeMode = resolveSizeMode(spriteComp?.sizeMode)
  for (const child of c.children) {
    if (child.label !== '__self') continue
    if (child instanceof Sprite || child instanceof NineSliceSprite || child instanceof TilingSprite) {
      const tex = child.texture
      if (tex && tex !== Texture.EMPTY) {
        applySpriteVisualSize(child, node, tex, sizeMode)
      } else {
        child.width = Math.max(1, node.width)
        child.height = Math.max(1, node.height)
      }
      if ('tint' in child && spriteComp) {
        ;(child as Sprite).tint = toTint(spriteComp.color)
      }
    } else if (child instanceof Graphics) {
      child
        .clear()
        .rect(lr.x, lr.y, node.width, node.height)
        .fill({ color: 0x4a90d9, alpha: 0.07 })
        .stroke({ color: 0x8899aa, width: 1, alpha: 0.35 })
    }
  }
}

// ---------- 精确命中测试 ----------

/** 将浏览器客户区坐标映射到 Pixi stage 坐标 */
function clientToStage(clientX: number, clientY: number): Point {
  if (!app || !wrapEl.value) {
    _stagePt.set(0, 0)
    return _stagePt
  }
  const rect = wrapEl.value.getBoundingClientRect()
  const x = ((clientX - rect.left) / Math.max(rect.width, 1)) * app.screen.width
  const y = ((clientY - rect.top) / Math.max(rect.height, 1)) * app.screen.height
  _stagePt.set(x, y)
  return _stagePt
}

/**
 * 用 toLocal（内部会刷新全局变换）把 stage 点转到节点本地空间，
 * 再与中心锚点矩形做包含判断。不依赖 Pixi 事件冒泡 / hitArea。
 */
function containsStagePoint(node: UINode, c: Container, stageX: number, stageY: number): boolean {
  if (!node.active || !c.visible || c.destroyed) return false
  _stagePt.set(stageX, stageY)
  // skipUpdate=false：沿父链重算变换，避免 rebuild 后矩阵过期
  c.toLocal(_stagePt, undefined, _local, false)

  const hw = Math.max(node.width, 1) / 2
  const hh = Math.max(node.height, 1) / 2
  return _local.x >= -hw && _local.x <= hw && _local.y >= -hh && _local.y <= hh
}

interface HitCandidate {
  node: UINode
  depth: number
  area: number
  /** 同级 children 下标：越大越靠上（与 addChild 顺序一致，不用 zIndex） */
  siblingIndex: number
}

/**
 * 收集所有包含点击点的节点，再按：
 * 1) 深度更深优先（子节点压过父节点 / Root）
 * 2) 同深度时面积更小优先（更精确的小节点）
 * 3) 同级 children 下标更大优先（后创建的在上，不用 zIndex）
 */
function pickBestNode(root: UINode, stageX: number, stageY: number): UINode | null {
  const hits: HitCandidate[] = []
  const walk = (node: UINode, depth: number, siblingIndex: number) => {
    const c = idMap.get(node._id)
    if (!c || c.destroyed) return

    for (let i = 0; i < node.children.length; i++) {
      walk(node.children[i], depth + 1, i)
    }

    if (containsStagePoint(node, c, stageX, stageY)) {
      hits.push({
        node,
        depth,
        area: Math.max(node.width, 1) * Math.max(node.height, 1),
        siblingIndex,
      })
    }
  }
  walk(root, 0, 0)

  if (!hits.length) return null

  hits.sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth
    if (a.area !== b.area) return a.area - b.area
    return b.siblingIndex - a.siblingIndex
  })
  return hits[0].node
}

// ---------- 选中高亮框（仅自身尺寸，不含子节点包围盒） ----------

function updateSelectionOutline() {
  if (!selectionG || !handlesLayer || !world) return
  selectionG.clear()
  const id = editor.selectedId
  const node = findNodeById(editor.currentUIData as UINode | null, id)
  const c = id ? idMap.get(id) : null
  if (!node || !c || c.destroyed) {
    handlesLayer.visible = false
    return
  }

  // 用中心锚点四角的全局坐标画框，避免 getBounds() 把子孙包进来导致误点
  const hw = node.width / 2
  const hh = node.height / 2
  const cornersLocal = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: -hw, y: hh },
    { x: hw, y: hh },
  ]
  const corners = cornersLocal.map((p) => {
    _corner.set(p.x, p.y)
    return c.toGlobal(_corner, new Point(), false)
  })
  selectionG
    .moveTo(corners[0].x, corners[0].y)
    .lineTo(corners[1].x, corners[1].y)
    .lineTo(corners[3].x, corners[3].y)
    .lineTo(corners[2].x, corners[2].y)
    .lineTo(corners[0].x, corners[0].y)
    .stroke({ color: 0x38bdf8, width: 1.5 })

  handlesLayer.visible = true
  // 手柄顺序：左上、右上、左下、右下
  const handlePos = [corners[0], corners[1], corners[2], corners[3]]
  handles.forEach((h, i) => h.position.set(handlePos[i].x, handlePos[i].y))
}

// ---------- 交互 ----------

let dragging: {
  id: string
  startX: number
  startY: number
  localX: number
  localY: number
  moved: boolean
} | null = null

/** 视图平移：拖背景/Root/中键时移动整个 world（画布框+准星+节点一起动） */
let panning: { pointerX: number; pointerY: number; worldX: number; worldY: number } | null = null

let resizing: {
  id: string
  corner: number
  startX: number
  startY: number
  startW: number
  startH: number
  moved: boolean
} | null = null

let lastFilePath = ''

function onHandlePointerDown(e: FederatedPointerEvent, corner: number) {
  if (e.button !== 0) return
  const id = editor.selectedId
  const c = id ? idMap.get(id) : null
  const node = findNodeById(editor.currentUIData as UINode | null, id)
  if (!id || !c || !c.parent || !node) return
  e.stopPropagation()
  dragging = null
  resizing = {
    id,
    corner,
    startX: node.x,
    startY: node.y,
    startW: node.width,
    startH: node.height,
    moved: false,
  }
}

function applyResize(e: FederatedPointerEvent) {
  if (!resizing || !world) return
  const c = idMap.get(resizing.id)
  const node = findNodeById(editor.currentUIData as UINode | null, resizing.id)
  if (!c || !c.parent || !node) return

  const stage = clientToStage(e.clientX, e.clientY)
  const local = c.parent.toLocal(stage)
  const { corner, startX, startY, startW, startH } = resizing
  const halfW = startW / 2
  const halfH = startH / 2
  let left = startX - halfW
  let right = startX + halfW
  let top = startY - halfH
  let bottom = startY + halfH

  if (corner === 0) {
    left = local.x
    top = local.y
  } else if (corner === 1) {
    right = local.x
    top = local.y
  } else if (corner === 2) {
    left = local.x
    bottom = local.y
  } else {
    right = local.x
    bottom = local.y
  }

  const minX = Math.min(left, right)
  const maxX = Math.max(left, right)
  const minY = Math.min(top, bottom)
  const maxY = Math.max(top, bottom)
  const w = Math.max(1, Math.round(maxX - minX))
  const h = Math.max(1, Math.round(maxY - minY))
  const nx = Math.round(minX + w / 2)
  const ny = Math.round(minY + h / 2)

  if (w === node.width && h === node.height && nx === node.x && ny === node.y) return
  node.width = w
  node.height = h
  node.x = nx
  node.y = ny
  syncNodeVisual(c, node)
  resizing.moved = true
}

function beginDrag(id: string, stageX: number, stageY: number) {
  const c = idMap.get(id)
  const node = findNodeById(editor.currentUIData as UINode | null, id)
  if (!c || !c.parent || !node) return
  const local = c.parent.toLocal(new Point(stageX, stageY))
  dragging = { id, startX: node.x, startY: node.y, localX: local.x, localY: local.y, moved: false }
}

function beginPan(clientX: number, clientY: number) {
  if (!world) return
  userAdjustedView = true
  panning = {
    pointerX: clientX,
    pointerY: clientY,
    worldX: world.x,
    worldY: world.y,
  }
  setCanvasCursor('grabbing')
}

function setCanvasCursor(cursor: string) {
  if (wrapEl.value) wrapEl.value.style.cursor = cursor
  if (app?.canvas) app.canvas.style.cursor = cursor
}

/** 悬停在背景/Root 上显示 grab，悬停在子节点上恢复默认 */
function updateHoverCursor(e: FederatedPointerEvent) {
  if (panning || dragging || resizing) return
  const root = editor.currentUIData as UINode | null
  if (!root || !app) {
    setCanvasCursor('grab')
    return
  }
  const stage = clientToStage(e.clientX, e.clientY)
  const hit = pickBestNode(root, stage.x, stage.y)
  if (!hit || hit._id === root._id) {
    setCanvasCursor('grab')
  } else {
    setCanvasCursor('default')
  }
}

function onStagePointerDown(e: FederatedPointerEvent) {
  if (!app || !world) return

  // 中键：平移视图
  if (e.button === 1) {
    beginPan(e.clientX, e.clientY)
    return
  }
  if (e.button !== 0) return

  // 四角手柄自己处理（勿抢选）
  if (handles.includes(e.target as Graphics)) return

  const root = editor.currentUIData as UINode | null
  if (!root) {
    editor.selectedId = null
    beginPan(e.clientX, e.clientY)
    return
  }

  // 用 DOM 客户区坐标换算，避免 autoDensity / 事件目标导致的 global 偏差
  const stage = clientToStage(e.clientX, e.clientY)
  const hit = pickBestNode(root, stage.x, stage.y)

  // 空白处或 Root（设计画布背景）：左键拖动平移整个画布视图
  if (!hit || hit._id === root._id) {
    editor.selectedId = hit?._id ?? null
    dragging = null
    beginPan(e.clientX, e.clientY)
    return
  }

  // 子节点：选中并拖拽改坐标
  editor.selectedId = hit._id
  beginDrag(hit._id, stage.x, stage.y)
}

function onStagePointerMove(e: FederatedPointerEvent) {
  if (panning && world) {
    world.position.set(
      panning.worldX + (e.clientX - panning.pointerX),
      panning.worldY + (e.clientY - panning.pointerY),
    )
    return
  }
  if (resizing) {
    applyResize(e)
    return
  }
  if (!dragging) {
    updateHoverCursor(e)
    return
  }
  const c = idMap.get(dragging.id)
  const node = findNodeById(editor.currentUIData as UINode | null, dragging.id)
  if (!c || !c.parent || !node) return
  const stage = clientToStage(e.clientX, e.clientY)
  const local = c.parent.toLocal(stage)
  const nx = Math.round(dragging.startX + local.x - dragging.localX)
  const ny = Math.round(dragging.startY + local.y - dragging.localY)
  if (nx === node.x && ny === node.y) return
  node.x = nx
  node.y = ny
  c.position.set(nx, ny)
  dragging.moved = true
}

function onStagePointerUp(e?: FederatedPointerEvent) {
  if (panning) {
    panning = null
    if (e) updateHoverCursor(e)
    else setCanvasCursor('grab')
    return
  }
  if (resizing) {
    const resized = resizing.moved
    resizing = null
    if (resized) {
      editor.commit()
      queueRebuild()
    }
    return
  }
  if (!dragging) return
  const moved = dragging.moved
  dragging = null
  if (moved) {
    editor.commit()
    queueRebuild()
  }
}

function onWheel(e: WheelEvent) {
  if (!world || !wrapEl.value) return
  e.preventDefault()
  userAdjustedView = true
  const rect = wrapEl.value.getBoundingClientRect()
  const px = e.clientX - rect.left
  const py = e.clientY - rect.top
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
  const newScale = Math.min(Math.max(world.scale.x * factor, 0.1), 8)
  const k = newScale / world.scale.x
  world.position.set(px - (px - world.x) * k, py - (py - world.y) * k)
  world.scale.set(newScale)
}

// ---------- 生命周期 ----------

onMounted(async () => {
  if (!wrapEl.value) return
  const application = new Application()
  await application.init({
    background: 0x161618,
    resizeTo: wrapEl.value,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  })
  if (destroyed) {
    application.destroy(true, { children: true })
    return
  }
  app = application
  wrapEl.value.appendChild(app.canvas)

  world = new Container()
  world.sortableChildren = true
  frameG = new Graphics()
  frameG.eventMode = 'none'
  frameG.zIndex = -1000000
  world.addChild(frameG)

  selectionG = new Graphics()
  selectionG.eventMode = 'none'
  handlesLayer = new Container()
  handlesLayer.visible = false
  handlesLayer.eventMode = 'static'
  for (let i = 0; i < 4; i++) {
    const handle = new Graphics()
      .rect(-5, -5, 10, 10)
      .fill(0x38bdf8)
      .stroke({ color: 0x0c4a6e, width: 1 })
    handle.eventMode = 'static'
    handle.hitArea = new Rectangle(-8, -8, 16, 16)
    handle.cursor = HANDLE_CURSORS[i]
    handle.on('pointerdown', (e: FederatedPointerEvent) => onHandlePointerDown(e, i))
    handles.push(handle)
    handlesLayer.addChild(handle)
  }
  app.stage.addChild(world, selectionG, handlesLayer)

  app.stage.eventMode = 'static'
  app.stage.hitArea = app.screen
  app.stage.on('pointerdown', onStagePointerDown)
  app.stage.on('pointermove', onStagePointerMove)
  app.stage.on('pointerup', onStagePointerUp)
  app.stage.on('pointerupoutside', onStagePointerUp)
  app.ticker.add(updateSelectionOutline)
  setCanvasCursor('grab')

  wrapEl.value.addEventListener('wheel', onWheel, { passive: false })

  // 视口尺寸变化时，把设计画布与十字准星重新置于正中央
  resizeObserver = new ResizeObserver(() => {
    if (!app) return
    // resizeTo 已处理画布缓冲；下一帧用新的 screen 尺寸回中
    requestAnimationFrame(() => centerWorldView(false))
  })
  resizeObserver.observe(wrapEl.value)

  centerWorldView(true)
  queueRebuild()
})

onBeforeUnmount(() => {
  destroyed = true
  resizeObserver?.disconnect()
  resizeObserver = null
  wrapEl.value?.removeEventListener('wheel', onWheel)
  app?.destroy(true, { children: true, texture: true })
  app = null
  world = null
  frameG = null
  selectionG = null
  handlesLayer = null
  handles = []
})

watch(() => editor.currentUIData, queueRebuild, { deep: true })

watch(
  () => [editor.canvasWidth, editor.canvasHeight] as const,
  () => {
    updateDesignFrame()
    queueRebuild()
    centerWorldView(false)
  },
)

watch(
  () => editor.currentFilePath,
  (path) => {
    if (path && path !== lastFilePath) {
      lastFilePath = path
      userAdjustedView = false
      centerWorldView(true)
      queueRebuild()
    }
  },
)

watch(
  () => project.assetVersion,
  () => {
    textureCache.clear()
    queueRebuild()
  },
)
</script>

<template>
  <div ref="wrapEl" class="relative overflow-hidden bg-[#161618]">
    <div
      class="pointer-events-none absolute top-2 left-3 z-10 text-[11px] text-zinc-600 select-none"
    >
      原点默认正中央 · 拖背景/Root平移画布 · 拖子节点移动 · 拖四角缩放 · 滚轮缩放
    </div>
    <div
      class="pointer-events-none absolute top-2 right-3 z-10 text-[11px] text-zinc-500 select-none"
    >
      {{ editor.resolutionLabel }} · {{ editor.orientation === 'landscape' ? '横屏' : '竖屏' }}
    </div>
  </div>
</template>
