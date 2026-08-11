# 角色与目标

你是资深前端 / 游戏 UI 编辑器工程师。请实现一个轻量级、类 Cocos Creator 的**节点树 UI 编辑工具**。

- **纯网页端**：用现代浏览器 `showDirectoryPicker()`（File System Access API）挂载本地项目目录，无服务端直接读写。
- **批处理 CLI**：与网页共用同一套纯逻辑核心（见第七节）。
- **交付目标**：任意 agent 按本文实现，须得到**等价功能**与**可复现的数据产物**（同一 PSD / 同一 UI JSON → 结构、坐标、枚举、导出目录一致；UUID 同种子稳定）。

---

# 〇、Agent 实现契约（必读，保证可复现）

## 0.1 单一事实来源
1. **本文 + 仓库内既有参考文件**是唯一规格；禁止凭「常见编辑器习惯」擅自改坐标、层级、枚举或目录约定。
2. 脚本模板必须来自 `codePreview/cocosPrefab.md` 中的 `ts` 代码块（占位符 `FileName`）。
3. 默认组件库以本文 **§2.4 完整 `components.json`** 为准（勿用旧示例里的 `sizeMode: CUSTOM`）。

## 0.2 锁定项（禁止分叉）
| 项 | 锁定值 |
|---|---|
| 框架 | Vue 3 Composition API + Vite + TypeScript |
| 状态 | Pinia |
| UI 库 | **Element Plus**（必须用 `el-tree` / `el-collapse`；**不要**换 Naive UI） |
| 样式 | Tailwind CSS，暗黑专业编辑器外壳 |
| 画布 | PixiJS 8（`Container` / `Sprite` 对应节点树） |
| PSD | `ag-psd`（浏览器走 canvas；Node/CLI 走 `useImageData` + `pngjs`） |
| 引擎导出 | Cocos Creator **3.8.x** Prefab / `.meta` |
| 设计分辨率 | 横屏默认 `1366×768`；竖屏为宽高对调 |
| 写盘防抖 | **300ms** |
| 历史栈 | 最大 **50** 步；`Ctrl+Z` / `Ctrl+Y` |
| Root 名 | 默认 `"Root"` |
| 新建项目默认 UI | `main.json` |
| 项目初始化 | `components.json` + `assets/` + `main.json` |

## 0.3 等价判定（跨实现验收）
对同一输入，不同实现必须满足：

| 场景 | 必须一致（允许差异） |
|---|---|
| PSD → UI JSON | 节点树结构、`name`/`active`/`x`/`y`/`width`/`height`、`children` 顺序、Sprite `framePath` 集合、Opacity 挂载规则一致。允许 `_id` 等运行时字段、JSON key 顺序、空白格式差异。 |
| UI JSON → Prefab 包 | 目录结构、图片清单、节点层级、`_lpos.y = -y`、枚举数值、SpriteFrame `uuid@f9941` 引用形态一致。`fileId` 等随机字段可不同；**同路径图片 UUID 须由稳定种子算法生成**（见 §6.2）。 |
| CLI ↔ 网页 | 同一 PSD / 同一 JSON：批处理结果与网页按钮产物在上表意义上等价。 |

## 0.4 实现约束
- 核心逻辑（PSD、节点规范化、Prefab 构建、`sanitizeFsName`、UUID）必须与 DOM / Pinia / `showDirectoryPicker` **解耦**，供网页与 CLI 共用。
- CLI **禁止**依赖 `window` / File System Access API。
- 写盘 JSON **必须剥离**运行时 `_id`。
- 出现歧义时：以「可复现数据产物」优先于视觉微调。

---

# 一、技术栈与工程建议

1. **Vue 3 + Vite + TS**：为 UI 节点与 `components.json` 提供严格接口。
2. **Pinia**：`currentUIData`、防抖写盘、历史栈、全局快捷键。
3. **Element Plus + Tailwind**：左树 `el-tree`（`draggable`）、属性区 `el-collapse`；外壳 Dark。
4. **PixiJS 8**：场景树、选中框、拖拽位移、四角缩放、视图平移/滚轮缩放。
5. **CLI**：Node.js ≥ 18；`package.json` 提供 `bin`（如 `uieditor`）与 `npm run cli -- …`。
6. **建议目录**（可微调，但须保持「core 与 UI 分离」）：
   - `src/types/`、`src/utils/`（或 `src/core/`）：纯逻辑
   - `src/stores/`、`src/components/`：网页
   - `cli/`：CLI 入口
   - `config/components.json`：内置默认组件库（新建项目写入根目录）

---

# 二、核心数据结构与约束

## 2.1 节点 `UINode`（强制字段）

```ts
interface UINode {
  _id: string              // 仅内存；写盘剥离
  name: string
  active: boolean
  x: number                // 相对父节点；锚点为节点中心
  y: number                // Y 向下为正（与 PSD 一致；导出 Cocos 时取反）
  width: number
  height: number
  zIndex: number           // 默认同级 children 下标；越大越靠上；渲染以 children 顺序为准，禁止用 zIndex 重排绘制
  components: Record<string, Record<string, unknown>>
  children: UINode[]
}
```

新建子节点默认：`active: true`，`x/y: 0`，`width/height: 100`，`components: {}`，`children: []`。

## 2.2 Root 保护与设计分辨率
- 每个 UI JSON **有且仅有一个根**；默认名 `"Root"`。
- Root **不可删除**、树中 **不可拖拽改父级**、Inspector **不显示删除**。
- Root 尺寸 = 设计分辨率；坐标固定 `(0,0)`。
- 切换横竖屏 / 设置分辨率 → 同步写回 Root 宽高；属性栏与四角缩放 **不可**改 Root 宽高。
- 新建 UI：自动生成仅含 Root 的最小合法 JSON（默认 `1366×768`）。

## 2.3 组件互斥
- `components.json` 每项可含 `componentType?: number`。
- 规则：同名组件只能挂一个；若定义了 `componentType`，则**同 `componentType` 也只能挂一个**。
- Sprite 与 Label 同属 `componentType: 1`，互斥；Opacity 为 `2`；SimpleList 为 `3`。

## 2.4 默认 `components.json`（新建项目必须写入；规格以本块为准）

```json
{
  "OpacityComponent": {
    "properties": {
      "opacity": { "type": "number", "default": 255 }
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
  },
  "LabelComponent": {
    "properties": {
      "text": { "type": "string", "default": "" },
      "color": { "type": "color", "default": "#FFFFFF" },
      "fontSize": { "type": "number", "default": 24 },
      "lineHeight": { "type": "number", "default": 24 },
      "fontFamily": { "type": "string", "default": "Arial" },
      "enableWrapText": { "type": "boolean", "default": false },
      "isBold": { "type": "boolean", "default": false },
      "horizontalAlign": {
        "type": "enum",
        "default": "CENTER",
        "options": [
          { "label": "LEFT", "value": "LEFT" },
          { "label": "CENTER", "value": "CENTER" },
          { "label": "RIGHT", "value": "RIGHT" }
        ]
      },
      "verticalAlign": {
        "type": "enum",
        "default": "CENTER",
        "options": [
          { "label": "TOP", "value": "TOP" },
          { "label": "CENTER", "value": "CENTER" },
          { "label": "BOTTOM", "value": "BOTTOM" }
        ]
      },
      "cacheMode": {
        "type": "enum",
        "default": "BITMAP",
        "options": [
          { "label": "NONE", "value": "NONE" },
          { "label": "BITMAP", "value": "BITMAP" },
          { "label": "CHAR", "value": "CHAR" }
        ]
      },
      "overflow": {
        "type": "enum",
        "default": "NONE",
        "options": [
          { "label": "NONE", "value": "NONE" },
          { "label": "CLAMP", "value": "CLAMP" },
          { "label": "RESIZE_HEIGHT", "value": "RESIZE_HEIGHT" },
          { "label": "SHRINK", "value": "SHRINK" }
        ]
      }
    },
    "componentType": 1
  }
}
```

属性类型：`string` | `number` | `boolean` | `color` | `v2` | `enum`。枚举在 JSON / 内存中存 **字符串 value**（如 `"TRIMMED"`），导出 Prefab 时再映射为引擎数值。

## 2.5 文件名安全 `sanitizeFsName`
```text
替换 [\/:*?"<>|] → _
空白 → _
去掉前导 .
trim；若结果为空 → "untitled"
```

## 2.6 读写规范化
- **读入**：补齐缺失基础字段；为整树生成运行时 `_id`；子节点缺 `zIndex` 时用其在父 `children` 中的下标。
- **写出**：`JSON.stringify(..., 2)`，key `_id` 不落盘。

---

# 三、界面布局与功能

## 3.1 顶部栏
- 【新建项目】：选目录 → 初始化 `components.json` + `assets/` + `main.json`（已存在且非空的 `components.json` / `main.json` 勿盲目覆盖）。
- 【导入项目】：`showDirectoryPicker`；空目录可自动初始化。
- 【新建UI界面】：创建含 Root 的默认 JSON。
- 【导入UI界面】：外部 `.json` 打开（可写入项目或仅编辑）。
- 【导出UI界面】：当前 UI 另存。
- 【切换横竖屏】：默认横屏；交换设计宽高并同步 Root。
- 【设置分辨率】：默认 `1366×768`；同步 Root。
- 【导入PSD】✓CLI（第五节）。
- 【导出 Cocos Creator3.x Prefab】✓CLI（第六节）；网页导出时弹出**通用进度框**（与引擎解耦，见 §6.7）。
- 【编辑组件库】：Modal（Monaco 或 textarea）编辑 `components.json`；保存校验 JSON → 写盘 → 刷新 Pinia 预设。

## 3.2 左侧
- **上：节点树**（`el-tree` + `draggable`）
  - 拖拽改父子/同级顺序，实时写回数据源；结束后按新顺序重排同级 `zIndex`。
  - 右键：新建子节点、复制、删除（Root 禁用删除/非法拖拽）。
  - **新建子节点后不要自动展开层级树**。
- **下：项目文件树**
  - 递归展示；双击 `.json` 切换当前 UI。
  - 右键：删除、新建文件夹等（`components.json` 应引导走「编辑组件库」，避免误当 UI 打开）。

## 3.3 中间画布（PixiJS）
- 按 `currentUIData` 递归构建场景；`SpriteComponent.framePath` 有效则加载本地图（Blob URL / Base64）。
- Label / Opacity 在画布上做合理预览即可（不必像素级等同 Cocos）。
- **坐标系**：设计画布中心 = 全局 `(0,0)`；设计框与中心十字准星默认居中视口；容器尺寸变化自动回中；用户平移/缩放后以用户视图为准。
- **点选命中（必须）**：收集指针下所有命中节点，再决定选中：
  1. **粘滞选中**：若节点树当前选中节点仍在命中集合中，则继续选中它（例：`Root→A→B→C→D`，D 与 B 相交区域 E；树中已选 D 时，在画布点 E 仍为 D，不跳到 B）。
  2. **无当前选中**（或当前选中未命中）：`depth` 更大优先（更深 = 更具体）。同链上均命中时顺序为 **D > C > B > A**。
  3. 同深度：面积 `width*height` 更小优先；再同：同级 `children` 下标更大优先。
  → 取第一名。禁止点嵌套子节点时误选 Root（Root 仅在无其它命中时可选）。
- **双击下钻（必须）**：在已选中任意非 Root 节点时，于该节点命中区域内**双击**，选中其子树中「更浅一层」的命中节点；**连续双击则逐级向下**。例：已选 D，且 D 下有 `E→F→G…`，在 D 区域双击 → 选 E；再双击 → 选 F；再双击 → 选 G。若点击处无更深层子节点命中，则保持当前选中。
- **拖拽节点**：左键拖非空白/非 Root 平移，实时写 `x/y`；**松手**记入历史。
- **视图平移**：空白或 Root 上左键拖、或中键拖。
- **滚轮**：缩放视图。
- **四角缩放**：选中后四角控制点；对角锚点固定；更新 `width/height`（拖左/上边时同步 `x/y`）；最小 `1×1`；Root 禁止；**松手**记入历史。
- 同级绘制顺序 = `children` 顺序（后添加在上），**不要**按 `zIndex` 重排。

## 3.4 右侧 Inspector
- 基础字段：`name`, `active`, `x`, `y`, `width`, `height`, `zIndex` +「删除节点」（Root 隐藏）。
- 「添加组件」来自 `components.json`，受 §2.3 互斥约束。
- `el-collapse`：标题左类型、右删组件。
- 按 `type` 渲染：`string→el-input`，`number→el-input-number`（min/max），`boolean→el-switch`，`color→el-color-picker`，`enum→el-select`，`v2→` 双数字或等价。
- `SpriteComponent.framePath`：Drop Target（`dragover`/`drop`），接收资源管理器拖入的**项目相对路径**。
- `SimpleListComponent.scriptPath`：可拖入/输入本机脚本路径；校验为脚本文件（非文件夹），并读取同名 `.meta` 自动填入 `scriptUuid`。

## 3.5 底部资源管理器
- 仅显示项目内 `.png/.jpg/.webp`；选中文件夹时可过滤到该目录。
- 【手动刷新】+ Window Focus 时轮询/重扫，图片增删后刷新列表。
- 拖到 `framePath` 写入相对路径。

---

# 四、数据流与历史

## 4.1 单向数据流
- Pinia `currentUIData` 为唯一源；树 / 画布 / Inspector 修改立即更新并重绘。
- 写盘：**300ms debounce**，或输入框 `blur` 时异步写入当前 JSON 文件。

## 4.2 Undo / Redo
压栈时机：**节点拖拽结束、添加/删除组件、输入完成（blur/回车）、画布拖节点结束、四角缩放结束**（及同类「提交点」）。  
容量 50；`Ctrl+Z` / `Ctrl+Y` 刷新视图并异步写盘。

---

# 五、PSD 导入（网页 + CLI）

## 5.1 产物路径
源 `A.psd` →：
- `{project}/A/UI/*.png`
- `{project}/A/A.json`

`--name` / 界面名经 `sanitizeFsName`；默认取 PSD 文件名去扩展名。

## 5.2 Root 与坐标公式（必须按此实现）
- Root 宽高 = **当前设计分辨率**（默认 1366×768），**不**用 PSD 文档尺寸。
- 图层像素矩形：`left/top` 来自图层；宽高优先导出 PNG / canvas 尺寸，否则用 `right-left` / `bottom-top`，至少为 1。
- 文档左上角矩形 → 编辑器中心锚点：
```text
x = left + width/2 - docW/2
y = top  + height/2 - docH/2
```
- 组：优先用 PS 组矩形；无效则用子节点包围盒并集（子节点此时仍为相对文档中心的绝对坐标），再把子节点转为相对父节点：`child.x -= parent.x`，`child.y -= parent.y`。
- **禁止**对坐标做额外缩放或「为好看」取整偏移（宽高可用 `Math.max(1, …)`）。

## 5.3 透明度
- 规范到 `0–1`：若 `opacity > 1` 则 `/255`；再 clamp 到 `[0,1]`，保留约 3 位小数。
- `< 1` 时挂 `OpacityComponent: { opacity }`；完全不透明不挂。

## 5.4 图层顺序（关键）
- PS 面板自上而下与引擎相反，但 **`ag-psd` 的 `children` 已是引擎顺序（底层在前）**。
- 生成节点时 **按该顺序直接 push，禁止 `reverse`**，禁止用 `zIndex` 控层。
- 例：面板自上而下 `a→b→c→d→e`（`e` 最底）→ 节点 `Root → e → d → c → b → a`。

## 5.5 像素层
- 导出 PNG；`SpriteComponent`：`framePath`、`color: "#FFFFFF"`、`sizeMode: "TRIMMED"`、`type: "SIMPLE"`。
- `active = !layer.hidden`。
- 同名 PNG：`name.png`、`name_1.png`…（大小写不敏感去重）。

## 5.6 环境差异
- 浏览器：`readPsd(buffer)` + `layer.canvas.toBlob`。
- Node：`readPsd(buffer, { useImageData: true })` + `pngjs` 编码，避免把 Node 专用解码打进浏览器主包。

---

# 六、导出 Cocos Creator 3.8 Prefab

## 6.1 入口与目录
- 网页：导出**当前打开** UI；选独立导出根目录。
- CLI：`export-prefab --project --ui --out [--force]`（不依赖「当前打开」）。
- `test.json` →：
```text
{out}/test/UI/          # 引用到的图片 + .meta
{out}/test/test.prefab
{out}/test/test.prefab.meta
{out}/test/test.ts      # 模板替换 FileName
{out}/test/test.ts.meta
# 各层目录 .meta
```

## 6.2 资源与稳定 UUID
- **只打包** JSON 中实际引用的 `SpriteComponent.framePath`；缺图失败并列出路径。
- Prefab 内必须用 SpriteFrame UUID（`{uuid}@f9941`），禁止写入路径字符串。
- 子 meta key：texture `6c48a`，sprite-frame `f9941`。
- **稳定 UUID**：由种子字符串（建议含「导出包内相对资源身份」，如同名导出路径）经可复现哈希生成 RFC 风格 UUID；**同路径多次导出 UUID 不变**。推荐算法（可原样实现）：
  - FNV-1a 32-bit 多轮混合扩展为 128-bit hex
  - 写入 version/variant 位后格式化为 `8-4-4-4-12`
- **compressUuid**（自定义脚本 `__type__`）：去连字符的 32 hex；保留前 5 位 hex，其余每 3 hex → 2 字符（字母表 `A–Za–z0–9+/`），得到 23 字符。与 `.ts.meta` 的 uuid 对应。

## 6.3 节点映射
- 每节点 → `cc.Node` + `cc.UITransform`（`_contentSize=w/h`，锚点 `(0.5,0.5)`）。
- `_layer = 1073741824`（UI_2D）。
- `_lpos = (x, -y, 0)`；旋转单位四元数；缩放 `(1,1,1)`。
- `SpriteComponent` → `cc.Sprite`：`_spriteFrame` / `_color` / `_type` / `_sizeMode`；`_isTrimmedMode = (sizeMode !== RAW)`。
- `LabelComponent` → `cc.Label`：`text` → `_string`；以及 color、fontSize、lineHeight、fontFamily、enableWrapText、isBold、对齐 / overflow / cacheMode；`_isSystemFontUsed: true`。
- `OpacityComponent` → `cc.UIOpacity`：编辑器侧按 `0–1`（兼容误写 `0–255`）转为引擎 0–255。
- `SimpleListComponent` → 同节点先挂 `cc.ScrollView`（`horizontal`/`vertical` 取自属性），再按 `scriptUuid`（可由 `scriptPath` 对应 `.meta` 自动填充）绑定自定义脚本；`ScrollView._content` 指向 `viewNode`（默认 `view/content`）。添加组件时自动创建子节点 `view` → `content`。导出时名为 `view` 的子节点自动挂 `cc.Mask`。
- 无上述组件则仅 Node + UITransform。
- 根组件顺序：`UITransform` →（可选 Sprite|Label|Opacity|ScrollView+脚本）→ **配套脚本** → PrefabInfo；脚本 `__type__` = compressUuid(`.ts.meta` uuid)，禁止写类名字符串。
- 子节点顺序 = JSON `children` 原序。

## 6.4 枚举数值（导出时转换）
| 字段 | 映射 |
|---|---|
| sizeMode | CUSTOM=0, TRIMMED=1, RAW=2（缺省 TRIMMED） |
| Sprite.type | SIMPLE=0, SLICED=1, TILED=2, FILLED=3（缺省 SIMPLE） |
| Label 水平/垂直对齐 | LEFT/TOP=0, CENTER=1, RIGHT/BOTTOM=2（缺省 CENTER） |
| overflow | NONE=0, CLAMP=1, SHRINK=2, RESIZE_HEIGHT=3 |
| cacheMode | NONE=0, BITMAP=1, CHAR=2（缺省 BITMAP） |
| SimpleList.itemCreationMode | NODE=0, PREFAB=1（缺省 PREFAB） |

FILLED：无 fill 细分属性时用引擎默认 fill 字段即可。

## 6.5 配套脚本
- 读取 `codePreview/cocosPrefab.md` 的 `ts` 块，全部 `FileName` → 安全界面名（如 `test`）。
- 网页与 CLI 均须生成；CLI 优先读磁盘 md，否则内置兜底同一模板。

## 6.6 验收
- 拷入空 Creator 3.8 工程 `assets`：无缺失引用；可打开 Prefab；层级/位置（含 Y 翻转）/贴图/枚举与编辑器一致；根已挂同名脚本。
- 覆盖：目标已存在时网页确认 / CLI 无 `--force` 则失败。

## 6.7 导出进度（通用，与引擎解耦）
- **目的**：网页导出 Prefab 时展示进度；后续 Unity 等引擎导出复用同一套 UI / 事件，禁止把进度框写死在 Cocos 导出里。
- **事件形状**（`ExportProgressEvent`，纯数据，无 Vue / Element Plus）：
  - `engine`：目标引擎 id（如 `"cocos"`；新增引擎扩展 `EXPORT_ENGINE_LABELS`）
  - `phase`：阶段 key（`prepare` / `read-images` / `write-images` / `write-prefab` / `write-script` / `done`）
  - `message`：用户可见文案
  - `current` / `total`：线性步进（`percent = round(current/total*100)`）
- **分层**：
  1. 核心导出（`exportCocosPrefabCore` 等）只接收可选 `onProgress?: (e) => void`，每步报告并 `yield` 主线程。
  2. `useExportProgress` + `ExportProgressDialog`：通用进度框；默认**首条进度再弹出**（先选目录 / 确认覆盖）。
  3. 顶栏入口：`runWithProgress('cocos', …)`；未来其它引擎改为 `runWithProgress('unity', …)` 即可。
- CLI：可不传 `onProgress`，或接到 stderr 日志；不弹 UI。

---

# 七、CLI

## 7.1 原则
只覆盖非交互批处理；与网页共用 core；成功退出码 `0`，失败非 0 + stderr。

## 7.2 命令
```text
uieditor import-psd --psd <file.psd> --project <dir> [--name <名>] [--width <n>] [--height <n>] [--force]
uieditor export-prefab --project <dir> --ui <json> --out <dir> [--force]
uieditor export-ui --project <dir> --ui <json> --out <file.json>
uieditor validate-ui --ui <json>
uieditor --help
```

- `import-psd`：行为同第五节；默认禁止覆盖，`--force` 可覆盖。
- `export-prefab`：行为同第六节；缺图/非法 JSON 失败。
- `export-ui`：规范化后另存（剥离 `_id`）。
- `validate-ui`：校验 Root / 基础字段 / 组件结构。

## 7.3 不做 CLI
新建/导入项目可视化、画布交互、节点拖拽、Inspector、组件库 Modal、撤销重做等。

## 7.4 验收
- 同 PSD：CLI vs 网页 JSON 树与图片集合等价（§0.3）。
- 同 UI JSON：CLI vs 网页 Prefab 结构/映射等价。
- `--help` 列出子命令与参数。

---

# 八、建议自测清单（实现完成后勾选）

1. Chrome/Edge：新建项目 → 出现 `components.json` / `assets/` / `main.json`。
2. 新建子节点、树拖拽排序、画布点选最深层、拖拽改 xy、四角改 wh、Root 不可删不可缩放。
3. 添加 Sprite/Label 互斥；资源拖到 `framePath`；300ms 写盘；Ctrl+Z/Y。
4. 导入 PSD：Root=设计分辨率；坐标公式；无 reverse；半透明有 Opacity。
5. 导出 Prefab：进 Creator 3.8 无红字；Y 翻转；枚举正确；根脚本存在；网页有通用进度框。
6. CLI：`import-psd` / `export-prefab` 与网页产物等价；`validate-ui` 对坏 JSON 非 0。
7. SimpleList：添加组件自动生成 `view/content`；导出含 ScrollView + Mask(view) + 脚本 UUID。

---

# 九、明确非目标（避免 scope 膨胀）
- 不实现完整 Cocos 运行时 / 动画时间轴 / 粒子。
- 不强制图集（Atlas）、Widget 全屏（可选）。
- 不支持无 File System Access API 的浏览器作为主路径（可提示换 Chrome/Edge）。
- 不为「好看」改变 §五 / §六 的数值约定。
