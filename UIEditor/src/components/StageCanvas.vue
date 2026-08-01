<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Application,
  Container,
  Graphics,
  Point,
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
let frameG: Graphics | null = null
let selectionG: Graphics | null = null
let handlesLayer: Container | null = null
let handles: Graphics[] = []
let destroyed = false
let viewInitialized = false

/** 四角控制点顺序：左上、右上、左下、右下 */
const HANDLE_CURSORS = ['nwse-resize', 'nesw-resize', 'nesw-resize', 'nwse-resize'] as const

/** 节点 _id -> Pixi 容器 */
const idMap = new Map<string, Container>()
const textureCache = new Map<string, Promise<Texture | null>>()

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

/** 中心锚点下的本地矩形：原点在节点中心 */
function localRect(w: number, h: number) {
  return { x: -w / 2, y: -h / 2, w, h }
}

// ---------- 场景构建（中心锚点；画布中心 = 全局 (0,0)） ----------

function buildNode(node: UINode): Container {
  const c = new Container()
  c.label = node._id
  c.position.set(node.x, node.y)
  c.visible = node.active
  c.zIndex = node.zIndex
  c.sortableChildren = true
  // 交互由舞台级精确命中测试负责，避免父子 hitArea 互相抢事件
  c.eventMode = 'none'
  const lr = localRect(node.width, node.height)
  c.hitArea = new Rectangle(lr.x, lr.y, Math.max(lr.w, 1), Math.max(lr.h, 1))
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
    sp.eventMode = 'none'
    sp.tint = toTint(spriteComp.color)
    sp.anchor.set(0.5)
    void loadTexture(framePath).then((texture) => {
      if (!texture || sp.destroyed) return
      sp.texture = texture
      sp.width = node.width
      sp.height = node.height
    })
    c.addChild(sp)
  } else {
    const g = new Graphics()
      .rect(lr.x, lr.y, node.width, node.height)
      .fill({ color: 0x4a90d9, alpha: 0.07 })
      .stroke({ color: 0x8899aa, width: 1, alpha: 0.35 })
    g.zIndex = -100000
    g.eventMode = 'none'
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

function updateDesignFrame() {
  if (!frameG) return
  const w = editor.canvasWidth
  const h = editor.canvasHeight
  frameG.clear()
  frameG
    .rect(-w / 2, -h / 2, w, h)
    .fill({ color: 0x1c1c1f, alpha: 0.55 })
    .stroke({ color: 0x52525b, width: 1 })
  // 画布中心十字准星
  frameG.moveTo(-12, 0).lineTo(12, 0).stroke({ color: 0x71717a, width: 1, alpha: 0.7 })
  frameG.moveTo(0, -12).lineTo(0, 12).stroke({ color: 0x71717a, width: 1, alpha: 0.7 })
}

function centerWorldView() {
  if (!app || !world) return
  world.scale.set(1)
  // 视口中心对准设计坐标原点 (0,0)
  world.position.set(Math.round(app.screen.width / 2), Math.round(app.screen.height / 2))
  viewInitialized = true
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
  c.hitArea = new Rectangle(lr.x, lr.y, Math.max(lr.w, 1), Math.max(lr.h, 1))
  for (const child of c.children) {
    if (child instanceof Sprite && child.zIndex <= -100000) {
      child.anchor.set(0.5)
      child.width = node.width
      child.height = node.height
    } else if (child instanceof Graphics && child.zIndex <= -100000) {
      child
        .clear()
        .rect(lr.x, lr.y, node.width, node.height)
        .fill({ color: 0x4a90d9, alpha: 0.07 })
        .stroke({ color: 0x8899aa, width: 1, alpha: 0.35 })
    }
  }
}

/**
 * 精确命中：自顶向下、子节点优先（按 zIndex 从高到低），
 * 解决点选子节点区域时误命中根节点的问题。
 */
function pickDeepestNode(root: UINode, global: Point): UINode | null {
  const walk = (node: UINode): UINode | null => {
    if (!node.active) return null
    const c = idMap.get(node._id)
    if (!c || c.destroyed) return null

    const kids = [...node.children].sort((a, b) => b.zIndex - a.zIndex)
    for (const kid of kids) {
      const hit = walk(kid)
      if (hit) return hit
    }

    const local = c.toLocal(global)
    const hw = node.width / 2
    const hh = node.height / 2
    if (local.x >= -hw && local.x <= hw && local.y >= -hh && local.y <= hh) {
      return node
    }
    return null
  }
  return walk(root)
}

// ---------- 选中高亮框 ----------

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

// ---------- 交互 ----------

let dragging: {
  id: string
  startX: number
  startY: number
  localX: number
  localY: number
  moved: boolean
} | null = null

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

/** 中心锚点：对角固定，更新中心坐标与宽高 */
function applyResize(e: FederatedPointerEvent) {
  if (!resizing || !world) return
  const c = idMap.get(resizing.id)
  const node = findNodeById(editor.currentUIData as UINode | null, resizing.id)
  if (!c || !c.parent || !node) return

  const local = c.parent.toLocal(e.global)
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

function beginDrag(id: string, e: FederatedPointerEvent) {
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
  if (e.button !== 0) return

  // 四角手柄自己处理
  if (handles.includes(e.target as Graphics)) return

  const root = editor.currentUIData as UINode | null
  if (!root) {
    editor.selectedId = null
    return
  }

  const hit = pickDeepestNode(root, e.global)
  if (hit) {
    editor.selectedId = hit._id
    beginDrag(hit._id, e)
  } else {
    editor.selectedId = null
    dragging = null
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

  wrapEl.value.addEventListener('wheel', onWheel, { passive: false })
  centerWorldView()
  queueRebuild()
})

onBeforeUnmount(() => {
  destroyed = true
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
  },
)

watch(
  () => editor.currentFilePath,
  (path) => {
    if (path && path !== lastFilePath) {
      lastFilePath = path
      centerWorldView()
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
      原点(0,0)=画布中心 · 左键选中/拖拽 · 拖四角缩放 · 中键平移 · 滚轮缩放
    </div>
    <div
      class="pointer-events-none absolute top-2 right-3 z-10 text-[11px] text-zinc-500 select-none"
    >
      {{ editor.resolutionLabel }} · {{ editor.orientation === 'landscape' ? '横屏' : '竖屏' }}
    </div>
  </div>
</template>
