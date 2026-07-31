# UI Editor — 类 Cocos Creator 节点树 UI 编辑器

轻量级纯网页端 UI 编辑工具：基于 File System Access API（`showDirectoryPicker()`）直接读写本地项目文件夹，无需任何服务端。

## 技术栈

- **Vue 3** (Composition API) + **Vite** + **TypeScript**
- **Pinia** — 响应式数据源、防抖写盘、撤销/重做历史栈
- **Element Plus** (`el-tree` / `el-collapse` 等) + **Tailwind CSS** 暗黑编辑器布局
- **PixiJS 8** — 中间画布渲染、边界框选、元素拖拽

## 启动

```bash
npm install
npm run dev
```

浏览器要求：Chrome / Edge 等支持 File System Access API 的浏览器（Safari / Firefox 不支持 `showDirectoryPicker`）。

## 使用说明

1. **新建项目**：选择一个本地文件夹，自动初始化 `components.json`、`assets/` 目录和默认 `main.json` UI 文件。
2. **导入项目**：挂载已有项目文件夹，左下方显示文件树，双击 `.json` 文件切换编辑的 UI 界面。
3. **编辑**：
   - 左上节点树支持拖拽调整层级/排序，右键新建子节点、复制、删除（根节点受保护）。
   - 中间画布左键点选并拖拽元素改坐标，中键平移视图，滚轮缩放。
   - 右侧属性栏编辑基础属性，按 `components.json` 的类型定义动态渲染组件属性输入控件。
   - 底部资源管理器展示项目内图片（页面重新聚焦时自动刷新），可拖入 `SpriteComponent.framePath`。
4. **保存**：所有修改经 300ms 防抖自动写回本地 JSON 文件；`Ctrl+Z` / `Ctrl+Y` 撤销重做（最多 50 步）。

## UI JSON 结构

```json
{
  "name": "Root",
  "active": true,
  "x": 0, "y": 0,
  "width": 960, "height": 640,
  "zIndex": 0,
  "components": {
    "SpriteComponent": { "framePath": "assets/bg.png", "color": "#FFFFFF", "sizeMode": 2, "type": 1 }
  },
  "children": []
}
```

组件类型约束定义在项目根目录的 `components.json` 中（支持 `string` / `number` / `boolean` / `color` / `v2`），可通过顶部「编辑组件库」修改。
