# 新建子节点不展开层级树 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 右键「新建子节点」时保留节点树展开/折叠状态，折叠的父节点不会被强制展开。

**Architecture:** Element Plus `el-tree` 没有真正受控的 `expanded-keys`。用自管 `expandedKeys` + `:default-expanded-keys` 在 `commit()` 整树重建后恢复展开态；关掉 `default-expand-all` 与选中时的自动展开父链。纯函数抽到 `nodeTreeExpand.ts` 便于断言测试。

**Tech Stack:** Vue 3 + Element Plus Tree + Pinia（只读 `editor` store，不改 store API）+ `npx tsx` 跑纯函数断言（项目无 vitest）

## Global Constraints

- 仅改节点树展开行为；不改 `addChild` / 拖拽 / 复制 / 画布选中同步语义（仍更新 `selectedId`）。
- 打开/切换 UI（根 `_id` 变化）仍默认全展开。
- 不引入新 npm 依赖；不用 `any`。
- Spec：`docs/superpowers/specs/2026-08-04-node-tree-expand-on-add-child-design.md`

---

## File map

| File | Role |
|------|------|
| `UIEditor/src/utils/nodeTreeExpand.ts` | `collectNodeIds` / `pruneExpandedKeys` |
| `UIEditor/src/utils/nodeTreeExpand.test.ts` | `tsx` 可跑的断言脚本 |
| `UIEditor/src/components/NodeTree.vue` | 去掉 `default-expand-all`，接上 keys 与 `setCurrentKey(..., false)` |

---

### Task 1: 纯函数 `collectNodeIds` / `pruneExpandedKeys`

**Files:**
- Create: `UIEditor/src/utils/nodeTreeExpand.ts`
- Create: `UIEditor/src/utils/nodeTreeExpand.test.ts`

**Interfaces:**
- Consumes: `UINode` from `UIEditor/src/types`
- Produces:
  - `collectNodeIds(root: UINode): string[]` — DFS 前序，含 root
  - `pruneExpandedKeys(keys: string[], root: UINode): string[]` — 只保留仍存在于树中的 id，保序去重

- [ ] **Step 1: Write the failing test**

Create `UIEditor/src/utils/nodeTreeExpand.test.ts`:

```ts
import assert from 'node:assert/strict'
import type { UINode } from '../types'
import { collectNodeIds, pruneExpandedKeys } from './nodeTreeExpand'

function node(id: string, children: UINode[] = []): UINode {
  return {
    _id: id,
    name: id,
    active: true,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    zIndex: 0,
    components: {},
    children,
  }
}

const tree = node('root', [node('a', [node('a1')]), node('b')])

assert.deepEqual(collectNodeIds(tree), ['root', 'a', 'a1', 'b'])
assert.deepEqual(pruneExpandedKeys(['root', 'gone', 'a', 'a', 'b'], tree), ['root', 'a', 'b'])
assert.deepEqual(pruneExpandedKeys(['x', 'y'], tree), [])

console.log('nodeTreeExpand.test.ts: ok')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd UIEditor && npx tsx src/utils/nodeTreeExpand.test.ts`

Expected: FAIL — `Cannot find module './nodeTreeExpand'`（或等价模块不存在错误）

- [ ] **Step 3: Write minimal implementation**

Create `UIEditor/src/utils/nodeTreeExpand.ts`:

```ts
import type { UINode } from '../types'

/** 深度优先收集整棵树的 `_id`（含 root） */
export function collectNodeIds(root: UINode): string[] {
  const ids: string[] = []
  const walk = (n: UINode) => {
    ids.push(n._id)
    for (const c of n.children) walk(c)
  }
  walk(root)
  return ids
}

/** 去掉已不存在的 key，保序且去重 */
export function pruneExpandedKeys(keys: string[], root: UINode): string[] {
  const alive = new Set(collectNodeIds(root))
  const out: string[] = []
  const seen = new Set<string>()
  for (const k of keys) {
    if (!alive.has(k) || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd UIEditor && npx tsx src/utils/nodeTreeExpand.test.ts`

Expected: stdout 含 `nodeTreeExpand.test.ts: ok`，exit 0

- [ ] **Step 5: Commit**

```bash
git add UIEditor/src/utils/nodeTreeExpand.ts UIEditor/src/utils/nodeTreeExpand.test.ts
git commit -m "$(cat <<'EOF'
feat: 节点树展开 keys 的纯函数与断言

EOF
)"
```

---

### Task 2: `NodeTree.vue` 受控恢复展开态

**Files:**
- Modify: `UIEditor/src/components/NodeTree.vue`
- Test: 手动按 Acceptance（dev server 已可 `npm run dev`）

**Interfaces:**
- Consumes: `collectNodeIds`, `pruneExpandedKeys` from Task 1；`editor.rootId` / `editor.currentUIData` / `editor.selectedId`
- Produces: 树展开态由 `expandedKeys` 驱动；`setCurrentKey(id, false)` 不展开父链

- [ ] **Step 1: 在 `<script setup>` 增加 expandedKeys 与辅助逻辑**

在现有 import 中加入 util；在 `treeRef` 后增加（替换选中 watch 为带 `false` 的版本）：

```ts
import { collectNodeIds, pruneExpandedKeys } from '../utils/nodeTreeExpand'

const expandedKeys = ref<string[]>([])

/** 打开 / 切换 UI：默认全展开 */
watch(
  () => editor.rootId,
  (id) => {
    const root = editor.currentUIData
    expandedKeys.value = id && root ? collectNodeIds(root) : []
  },
  { immediate: true },
)

/** 同 UI 内增删节点：只剪掉失效 key，不因新建而加入父 id */
watch(
  () => editor.currentUIData,
  (root) => {
    if (!root) {
      expandedKeys.value = []
      return
    }
    if (root._id !== editor.rootId) return
    expandedKeys.value = pruneExpandedKeys(expandedKeys.value, root)
  },
  { deep: true },
)

function onNodeExpand(data: UINode) {
  if (!expandedKeys.value.includes(data._id)) {
    expandedKeys.value = [...expandedKeys.value, data._id]
  }
}

function onNodeCollapse(data: UINode) {
  expandedKeys.value = expandedKeys.value.filter((k) => k !== data._id)
}

// store 选中态 → 树高亮；第二参 false = 不自动展开父链
watch(
  () => [editor.selectedId, editor.currentUIData] as const,
  async () => {
    await nextTick()
    if (editor.selectedId) treeRef.value?.setCurrentKey(editor.selectedId, false)
  },
  { immediate: true },
)
```

删除旧的 `setCurrentKey(editor.selectedId)` 那一段 watch（避免重复）。

注意：根 `_id` 切换时，第一个 watch 会写入全量 keys；随后 deep watch 的 `prune` 应仍得到全量（全部 alive）。若竞态导致先 prune 后 reset，以 `rootId` watch 为准即可。

- [ ] **Step 2: 更新 `<el-tree>` 模板绑定**

把：

```vue
        default-expand-all
        highlight-current
        :expand-on-click-node="false"
```

换成：

```vue
        :default-expanded-keys="expandedKeys"
        :auto-expand-parent="false"
        highlight-current
        :expand-on-click-node="false"
```

并在事件上增加：

```vue
        @node-expand="onNodeExpand"
        @node-collapse="onNodeCollapse"
```

完整 `el-tree` 起始属性区应类似：

```vue
      <el-tree
        v-if="treeData.length"
        ref="treeRef"
        class="panel-tree"
        :data="treeData"
        node-key="_id"
        :default-expanded-keys="expandedKeys"
        :auto-expand-parent="false"
        highlight-current
        :expand-on-click-node="false"
        draggable
        :allow-drag="allowDrag"
        :allow-drop="allowDrop"
        @node-click="onNodeClick"
        @node-drop="onNodeDrop"
        @node-expand="onNodeExpand"
        @node-collapse="onNodeCollapse"
        @node-contextmenu="onContextMenu"
      >
```

- [ ] **Step 3: Typecheck**

Run: `cd UIEditor && npm run typecheck`

Expected: exit 0，无新增错误

- [ ] **Step 4: 手动验收（Acceptance）**

在已运行的 dev 中验证：

1. 折叠某父节点 → 右键「新建子节点」→ 该父仍折叠；属性栏仍切到新节点。
2. 展开的父下新建 → 仍展开，可见新子节点。
3. 切换/新建另一 UI → 树再次默认全展开。
4. 手动折叠后，在其它分支增删节点 → 已折叠分支不被展开。

- [ ] **Step 5: Commit**

```bash
git add UIEditor/src/components/NodeTree.vue
git commit -m "$(cat <<'EOF'
fix: 新建子节点时保留节点树折叠状态

EOF
)"
```

---

## Spec coverage checklist

| Spec 要求 | Task |
|-----------|------|
| 去掉 `default-expand-all` / 用 keys 恢复 | Task 2 |
| 打开/切换 UI 全展开 | Task 2 `watch rootId` + `collectNodeIds` |
| expand/collapse 同步 keys | Task 2 handlers |
| 新建不改展开（不强制展开父） | Task 2：不往 keys 加父 id + `setCurrentKey(_, false)` + `auto-expand-parent=false` |
| 删除剪掉失效 keys | Task 1 `pruneExpandedKeys` + Task 2 deep watch |
| 不改 store / 非目标范围 | 无 store 改动 |

## Self-review notes

- EP 实际 prop 是 `default-expanded-keys`（非 `expanded-keys`）；spec 已同步更正。
- 根因是 `commit()` 替换整树 + `default-expand-all`，计划针对该路径恢复 keys。
