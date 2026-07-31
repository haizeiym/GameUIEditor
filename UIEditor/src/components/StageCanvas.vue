<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Application,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
  type FederatedPointerEvent,
} from 'pixi.js'
import type { UINode } from '../types'
import { useEditorStore } from '../stores/editor'
import { useProjectStore } from '../stores/project'
import { findNodeById } from '../utils/node'

const editor = useEditorStore()
const project = useProjectStore()
const wrapEl = ref<HTMLDivElement>()

let app: Application | null = null
let world: Container | null = null
let selectionG: Graphics | null = null
let handlesLayer: Container | null = null
let handles: Graphics[] = []
let destroyed = false
let lastCenteredFile: string | null = null

/** 四角控制点顺序：左上、右上、左下、右下 */
const HANDLE_CURSORS = ['nwse-resize', 'nesw-resize', 'nesw-resize', 'nwse-resize'] as const

/** 节点 _id -> Pixi 容器 */
const idMap = new Map<string, Container>()
const textureCache = new Map<string, Promise<Texture | null>>()

// ---------- 纹理加载（项目相对路径 -> 本地文件 -> Texture） ----------

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

/** SpriteComponent.color 支持 "#RRGGBB" 或 [r,g,b,a] 两种写法 */
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

// ---------- 场景构建 ----------

function buildNode(node: UINode): Container {
  const c = new Container()
  c.label = node._id
  c.position.set(node.x, node.y)
  c.visible = node.active
  c.zIndex = node.zIndex
  c.sortableChildren = true
  c.eventMode = 'static'
  c.hitArea = new Rectangle(0, 0, Math.max(node.width, 1), Math.max(node.height, 1))
  c.on('pointerdown', (e: FederatedPointerEvent) => onNodePointerDown(e, node._id))
  idMap.set(node._id, c)

  const opacityComp = node.components['OpacityComponent']
  if (opacityComp && typeof opacityComp.opacity === 'number') {
    c.alpha = Math.min(Math.max(opacityComp.opacity, 0), 1)
  }

  const spriteComp = node.components['SpriteComponent']
  const framePath = typeof spriteComp?.framePath === 'string' ? spriteComp.framePath : ''
  if (spriteComp && framePath) {
    const sp = new Sprite(Texture.EMPTY)
    sp.zIndex = -100000
    sp.tint = toTint(spriteComp.color)
    void loadTexture(framePath).then((texture) => {
      if (!texture || sp.destroyed) return
      sp.texture = texture
      sp.width = node.width
      sp.height = node.height
    })
    c.addChild(sp)
  } else {
    // 无贴图节点画半透明占位框，保证可见、可点选
    const g = new Graphics()
      .rect(0, 0, node.width, node.height)
      .fill({ color: 0x4a90d9, alpha: 0.07 })
      .stroke({ color: 0x8899aa, width: 1, alpha: 0.35 })
    g.zIndex = -100000
    c.addChild(g)
  }

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

function rebuild() {
  // 拖拽/四角缩放期间跳过重建，由交互逻辑直接改容器视觉属性
  if (!app || !world || dragging || resizing) return
  for (const child of world.removeChildren()) child.destroy({ children: true })
  idMap.clear()
  const data = editor.currentUIData
  if (!data) return
  world.addChild(buildNode(data as UINode))

  if (editor.currentFilePath !== lastCenteredFile) {
    lastCenteredFile = editor.currentFilePath
    world.scale.set(1)
    world.position.set(
      Math.round((app.screen.width - data.width) / 2),
      Math.round((app.screen.height - data.height) / 2),
    )
  }
}

/** 就地同步节点容器的位置与尺寸视觉（拖拽/缩放过程中避免整树重建） */
function syncNodeVisual(c: Container, node: UINode) {
  c.position.set(node.x, node.y)
  c.hitArea = new Rectangle(0, 0, Math.max(node.width, 1), Math.max(node.height, 1))
  for (const child of c.children) {
    if (child instanceof Sprite || child instanceof Graphics) {
      // 占位框 / Sprite 贴图都是 zIndex 极低的尺寸层
      if (child.zIndex <= -100000) {
        if (child instanceof Sprite) {
          child.width = node.width
          child.height = node.height
        } else {
          child.clear()
            .rect(0, 0, node.width, node.height)
            .fill({ color: 0x4a90d9, alpha: 0.07 })
            .stroke({ color: 0x8899aa, width: 1, alpha: 0.35 })
        }
      }
    }
  }
}

// ---------- 选中高亮框（每帧跟随） ----------

function updateSelectionOutline() {
  if (!selectionG || !handlesLayer) return
  selectionG.clear()
  const id = editor.selectedId
  const c = id ? idMap.get(id) : null
  if (!c || c.destroyed) {
    handlesLayer.visible = false
    return
  }
  const b = c.getBounds()
  selectionG.rect(b.x, b.y, b.width, b.height).stroke({ color: 0x38bdf8, width: 1.5 })
  handlesLayer.visible = true
  const corners = [
    [b.x, b.y],
    [b.x + b.width, b.y],
    [b.x, b.y + b.height],
    [b.x + b.width, b.y + b.height],
  ]
  handles.forEach((h, i) => h.position.set(corners[i][0], corners[i][1]))
}

// ---------- 交互：点选 / 拖拽元素 / 四角缩放 / 平移视图 ----------

let dragging: {
  id: string
  startX: number
  startY: number
  localX: number
  localY: number
  moved: boolean
} | null = null

let panning: { pointerX: number; pointerY: number; worldX: number; worldY: number } | null = null

/** 四角缩放中的状态；corner: 0左上 1右上 2左下 3右下 */
let resizing: {
  id: string
  corner: number
  startX: number
  startY: number
  startW: number
  startH: number
  localX: number
  localY: number
  moved: boolean
} | null = null

function onHandlePointerDown(e: FederatedPointerEvent, corner: number) {
  if (e.button !== 0) return
  const id = editor.selectedId
  const c = id ? idMap.get(id) : null
  const node = findNodeById(editor.currentUIData as UINode | null, id)
  if (!id || !c || !c.parent || !node) return
  e.stopPropagation()
  // 避免与节点拖拽冲突
  dragging = null
  const local = c.parent.toLocal(e.global)
  resizing = {
    id,
    corner,
    startX: node.x,
    startY: node.y,
    startW: node.width,
    startH: node.height,
    localX: local.x,
    localY: local.y,
    moved: false,
  }
}

function applyResize(e: FederatedPointerEvent) {
  if (!resizing) return
  const c = idMap.get(resizing.id)
  const node = findNodeById(editor.currentUIData as UINode | null, resizing.id)
  if (!c || !c.parent || !node) return
  const local = c.parent.toLocal(e.global)
  const dx = local.x - resizing.localX
  const dy = local.y - resizing.localY
  const { corner, startX, startY, startW, startH } = resizing

  const left = corner === 0 || corner === 2 // 拖动的是左边缘
  const top = corner === 0 || corner === 1 // 拖动的是上边缘
  const w = Math.max(1, Math.round(left ? startW - dx : startW + dx))
  const h = Math.max(1, Math.round(top ? startH - dy : startH + dy))
  const nx = left ? startX + (startW - w) : startX
  const ny = top ? startY + (startH - h) : startY

  if (w === node.width && h === node.height && nx === node.x && ny === node.y) return

  // 实时更新数据源：属性栏同步、防抖写盘由 store watcher 处理
  node.width = w
  node.height = h
  // 对角固定：拖左/上边缘时同步平移节点原点
  node.x = nx
  node.y = ny
  syncNodeVisual(c, node)
  resizing.moved = true
}

function onNodePointerDown(e: FederatedPointerEvent, id: string) {
  if (e.button !== 0) return
  e.stopPropagation()
  editor.selectedId = id
  const c = idMap.get(id)
  const node = findNodeById(editor.currentUIData as UINode | null, id)
  if (!c || !c.parent || !node) return
  const local = c.parent.toLocal(e.global)
  dragging = { id, startX: node.x, startY: node.y, localX: local.x, localY: local.y, moved: false }
}

function onStagePointerDown(e: FederatedPointerEvent) {
  if (!app || !world) return
  if (e.button === 1) {
    panning = { pointerX: e.global.x, pointerY: e.global.y, worldX: world.x, worldY: world.y }
    return
  }
  if (e.target === app.stage) {
    editor.selectedId = null
  }
}

function onStagePointerMove(e: FederatedPointerEvent) {
  if (panning && world) {
    world.position.set(
      panning.worldX + (e.global.x - panning.pointerX),
      panning.worldY + (e.global.y - panning.pointerY),
    )
    return
  }
  if (resizing) {
    applyResize(e)
    return
  }
  if (!dragging) return
  const c = idMap.get(dragging.id)
  const node = findNodeById(editor.currentUIData as UINode | null, dragging.id)
  if (!c || !c.parent || !node) return
  const local = c.parent.toLocal(e.global)
  const nx = Math.round(dragging.startX + local.x - dragging.localX)
  const ny = Math.round(dragging.startY + local.y - dragging.localY)
  if (nx === node.x && ny === node.y) return
  // 实时更新数据源：属性栏同步、防抖写盘由 store watcher 处理
  node.x = nx
  node.y = ny
  c.position.set(nx, ny)
  dragging.moved = true
}

function onStagePointerUp() {
  panning = null
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
  selectionG = new Graphics()
  handlesLayer = new Container()
  handlesLayer.visible = false
  handlesLayer.eventMode = 'static'
  for (let i = 0; i < 4; i++) {
    const handle = new Graphics()
      .rect(-5, -5, 10, 10)
      .fill(0x38bdf8)
      .stroke({ color: 0x0c4a6e, width: 1 })
    handle.eventMode = 'static'
    // 扩大点击热区，方便抓取四角
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

  wrapEl.value.addEventListener('wheel', onWheel, { passive: false })
  queueRebuild()
})

onBeforeUnmount(() => {
  destroyed = true
  wrapEl.value?.removeEventListener('wheel', onWheel)
  app?.destroy(true, { children: true, texture: true })
  app = null
  world = null
  selectionG = null
  handlesLayer = null
  handles = []
})

// 数据源任何变化 → 重建场景（画布拖拽期间跳过，由拖拽逻辑直接改容器坐标）
watch(() => editor.currentUIData, queueRebuild, { deep: true })

// 图片资产增删 → 失效纹理缓存并重建
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
      左键：选中/拖拽元素 · 拖四角：缩放大小 · 中键：平移 · 滚轮：缩放视图
    </div>
  </div>
</template>
