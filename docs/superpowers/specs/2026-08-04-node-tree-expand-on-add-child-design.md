# 新建子节点不展开层级树 — Design

## Goal

右键「新建子节点」时，节点树的展开/折叠状态保持不变：父节点若已折叠，新建后仍保持折叠；不因选中新节点或 `default-expand-all` 而强制展开父链或整棵树。

## Decision

采用 **受控 `expandedKeys`**（方案 1），仅改 `UIEditor/src/components/NodeTree.vue`；`editor.addChild` 等 store 逻辑不动。

## Behavior

| 场景 | 行为 |
|------|------|
| 打开 / 切换 UI（根节点 `_id` 变化） | 收集当前树全部节点 `_id`，写入 `expandedKeys`（保持「默认全展开」） |
| 用户点击展开/折叠 | `@node-expand` / `@node-collapse` 同步增删对应 key |
| 新建子节点 | **不修改** `expandedKeys`；仍 `selectedId = 新节点`；属性栏/画布照常 |
| 删除节点 | 从 `expandedKeys` 移除已不存在的 id |

折叠父节点下新建时：树上可能看不到当前高亮，属预期；选中态仍有效。

## Root cause

`editor.commit()` 用 `JSON.parse` **替换**整棵 `currentUIData`。`el-tree` 对 `data` 深监听后会 `setData` 重建节点；配合 `default-expand-all`，每次新建/删除都会把整树重新展开。另外 `setCurrentKey(id)` 默认 `shouldAutoExpandParent=true`，会展开到新选中节点。

## Implementation sketch

1. 移除 `el-tree` 的 `default-expand-all`。
2. 维护 `expandedKeys: ref<string[]>`，绑定 `:default-expanded-keys`（Element Plus **无**真正受控 `expanded-keys`；重建后靠 default keys 恢复展开态）。
3. `:auto-expand-parent="false"`；选中同步改为 `setCurrentKey(id, false)`，避免强制展开父链。
4. 辅助：`collectNodeIds(root)` / `pruneExpandedKeys(keys, root)`。
5. `watch` 根 `_id` 变化：`expandedKeys = collectNodeIds(root)`（打开/切换 UI 默认全展开）。
6. `@node-expand` / `@node-collapse`：按节点 `_id` 增删 keys。
7. 树数据变化（非根切换）时：`expandedKeys = pruneExpandedKeys(...)`，**不**因新建子节点往 keys 里塞父 id。

## Non-goals

- 不改拖拽、复制、画布点选同步。
- 不引入新依赖 / 新 store 字段。
- 不改变「打开 UI 默认全展开」的初始体验。

## Acceptance

1. 折叠某父节点 → 右键新建子节点 → 该父节点仍折叠。
2. 已展开的父节点下新建 → 仍展开，新子节点可见。
3. 切换 / 新建 UI 文件后，树再次默认全展开。
4. 手动折叠后增删其它节点，已折叠分支不被意外展开。
