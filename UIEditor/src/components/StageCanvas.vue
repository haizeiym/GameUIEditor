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
let destroyed = false
let lastCenteredFile: string | null = null

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
  if (!app || !world || dragging) return
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

// ---------- 选中高亮框（每帧跟随） ----------

function updateSelectionOutline() {
  if (!selectionG) return
  selectionG.clear()
  const id = editor.selectedId
  const c = id ? idMap.get(id) : null
  if (!c || c.destroyed) return
  const b = c.getBounds()
  selectionG.rect(b.x, b.y, b.width, b.height).stroke({ color: 0x38bdf8, width: 1.5 })
  for (const [hx, hy] of [
    [b.x, b.y],
    [b.x + b.width, b.y],
    [b.x, b.y + b.height],
    [b.x + b.width, b.y + b.height],
  ]) {
    selectionG.rect(hx - 3, hy - 3, 6, 6).fill(0x38bdf8)
  }
}

// ---------- 交互：点选 / 拖拽元素 / 平移缩放 ----------

let dragging: {
  id: string
  startX: number
  startY: number
  localX: number
  localY: number
  moved: boolean
} | null = null

let panning: { pointerX: number; pointerY: number; worldX: number; worldY: number } | null = null

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
  app.stage.addChild(world, selectionG)

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
      左键：选中/拖拽元素 · 中键：平移 · 滚轮：缩放
    </div>
  </div>
</template>
