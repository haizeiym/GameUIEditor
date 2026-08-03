
# 角色与目标
你是一个资深的前端与游戏/UI编辑器开发专家。请编写一个轻量级、类 Cocos Creator 3D 的节点树 UI 编辑工具。
工具必须采用纯网页端架构，利用现代浏览器的 `showDirectoryPicker()` (File System Access API) 让用户授权选择本地项目文件夹，实现无服务端的本地文件直接读写。

# 一、 技术栈选型要求 (Tech Stack)
为了保证复杂 JSON 数据流的性能、类型安全以及编辑器级别的交互体验，必须使用以下技术栈：
1. **基础框架**：Vue 3 (Composition API) + Vite + TypeScript (提供严格的 JSON 节点接口定义)。
2. **状态管理**：Pinia（核心响应式数据源，负责全局事件流、防抖写盘与历史栈监听）。
3. **UI 与基础控件**：Element Plus (或 Naive UI) + Tailwind CSS。必须利用其自带的 `el-tree`（支持拖拽的树组件）和 `el-collapse`（折叠面板）构建面板。外壳采用 Tailwind 实现暗黑系（Dark Mode）专业编辑器布局。
4. **中间画布渲染**：PixiJS (2D 渲染引擎)。利用 PixiJS 嵌套的 `Container` 和 `Sprite` 概念天然对应 UI 的节点树，处理高帧率 2D 视图渲染、边界框选（Bounding Box）及元素鼠标拖拽。
5. **CLI（命令行）**：凡不依赖画布交互 / 节点树拖拽 / Inspector 编辑的**批处理能力**，须同时提供 Node.js CLI，与网页端共用同一套核心逻辑（详见第七节）。

# 二、 核心数据结构与约束机制

## 1. 内置变换组件 (Transform / Base Node Properties)
每个节点（Node）除了可选挂载的自定义组件外，**强制且唯一**内置以下基础空间属性，不允许用户删除，直接映射到 PixiJS 的属性上：
- `name`: 节点名称（String）
- `active`: 是否激活（Boolean）
- `x`, `y`: 相对父节点的坐标（Number）
- `width`, `height`: 节点的宽高尺寸（Number）
- `zIndex`: 渲染层级次序（Number，**越大越靠上绘制**；默认等于其在父节点 `children` 中的下标，即列表越靠下越上层）

## 2. 根节点（Root）保护机制
- 每个 UI JSON 文件必须有且仅有一个根节点（例如名称为 "Canvas" 或 "Root"）。
- 根节点**禁止被删除**，在左侧树中**禁止被拖拽**到其他节点下方，右侧属性栏不显示删除按钮。
- 新建 UI 界面时，必须自动初始化包含此根节点的最小合法 JSON 结构。

## 3. 组件定义规范 (./components.json)
组件定义必须包含**属性类型校验约束**，示例结构如下：
```json
{
  "SpriteComponent": {
    "properties": {
      "framePath": { "type": "string", "default": "" },
      "color": { "type": "color", "default": "#FFFFFF" },
      "sizeMode": { "type": "enum", "default": "CUSTOM", "options": [{"label":"CUSTOM","value":"CUSTOM"},{"label":"TRIMMED","value":"TRIMMED"},{"label":"RAW","value":"RAW"}] },
      "type": { "type": "enum", "default": "SIMPLE", "options": [{"label":"SIMPLE","value":"SIMPLE"},{"label":"SLICED","value":"SLICED"},{"label":"TILED","value":"TILED"},{"label":"FILLED","value":"FILLED"}] }
    }
  }
}
```

# 三、 界面布局与核心功能要求

## 1. 顶部导航栏 (Top Bar)
- **项目操作**：
  - 【新建项目】：选择空目录并初始化项目结构（含默认 `components.json`、示例 UI 等）。
  - 【导入项目】：调用 `showDirectoryPicker` 挂载本地文件夹；空目录可自动初始化。
- **UI 文件与资源操作**（按钮须齐全；带 ✓CLI 的须有命令行等价能力，见第七节）：
  - 【新建UI界面】：在项目下创建默认 JSON（含 Root）。
  - 【导入UI界面】：从外部选择 `.json` 打开（可写入当前项目或仅编辑）。
  - 【导出UI界面】：将当前 UI JSON 另存为文件。
  - 【切换横竖屏】：默认横屏；切换时交换设计宽高并同步 Root。
  - 【设置分辨率】：默认 `1366×768`；修改后同步 Root 宽高。
  - 【导入PSD】✓CLI：选择 `.psd`，解析图层 PNG + 生成同名 JSON（第五节）。
  - 【导出 Cocos Creator3.x Prefab】✓CLI：将当前（或指定）UI JSON 导出为 Creator 3.8 资源包（第六节）。
- **配置编辑**：【编辑组件库】弹出 Modal，内置 Monaco 或简易编辑器展示 `./components.json`；保存时校验 JSON，写回本地并刷新 Pinia 组件预设。

## 2. 左侧控制面板 (Left Panel)
- **左上方（节点树区）**：
  - 使用 `el-tree` 递归展示当前 UI 的节点层级。
  - 开启 `draggable` 属性，支持节点间的拖拽以改变父子关系或同级排序，拖拽结果必须实时更新绑定的数据源。
  - 右键菜单提供：新建子节点（自动附加基础属性）、复制节点、删除节点（根节点禁用）。
- **左下方（项目文件列表）**：
  - 递归展示项目根目录下的文件树。双击 `.json` 文件切换当前编辑的 UI 界面。
  - 选中文件或文件夹时，右键可以删除，新建文件夹等操作

## 3. 中间画布区域 (Stage / Canvas)
- **PixiJS 渲染舞台**：根据 Pinia 中的节点树数据递归构建 PixiJS 场景树。当节点挂载 `SpriteComponent` 且包含有效的本地图片路径时，加载对应的 Base64/Blob URL 并渲染。
- **视图交互**：
  - 左键点击画布中的某个 PixiJS 元素，左侧节点树高亮选中，右侧属性栏同步切换。
  - 选中的元素在画布中显示高亮边框，**支持直接用鼠标拖拽元素，实时改变并向上传递其 `x` 和 `y` 坐标**。
  - 要以画布中心点为坐标(0,0)点，设计画布框与中心十字准星必须始终位于中间画布视口的正中央（容器尺寸变化时自动回中；用户平移/缩放视图后以用户视图为准）。画布点选必须做「深度优先 + 同层面积最小」的精确命中：点击嵌套子节点（如 Root→Node1→Node2）时选中最具体的那一层，绝不可误选 Root。
  - **画布背景拖动**：空白区域或 Root（设计画布）上按住左键拖动可平移整个视图，设计画布框、十字准星与全部节点同步移动；中键拖动同样平移。默认打开/复位时视图位于中间画布区域正中央。
  - **四角缩放**：选中节点后，高亮边框的四个角显示可交互缩放控制点（悬停时切换为对应方向的缩放光标，如 `nwse-resize` / `nesw-resize`）。**按住任一角并用鼠标拖动即可修改节点大小**：以对角为固定锚点，实时同步更新 `width`、`height`（拖动左/上边缘时同时平移 `x`、`y` 以保持对角不动），最小尺寸限制为 1×1；缩放过程中属性栏与画布即时刷新并防抖写盘，**松开鼠标时将本次缩放记入撤销历史**。

## 4. 右侧属性编辑面板 (Inspector)
- **基础属性**：固定展示当前节点的 `name`, `active`, `x`, `y`, `width`, `height`。提供“删除节点”按钮。
- **组件管理**：
  - 提供“添加组件”下拉菜单，读取自 `components.json` 的可用类型。
  - 根据`components.json`中组件的componentType属性，一个节点同一个属性的组件，只能添加一个
  - 使用 `el-collapse` 包裹挂载的组件，标题栏左侧为类型，右侧为“删除组件”按钮。
  - **类型安全输入**：展开后，根据 `components.json` 中定义的 `type` 动态渲染：`string` 对应 `el-input`；`number` 对应 `el-input-number`（绑定 `min`/`max` 限制）；`boolean` 对应 `el-switch`，`color`对应 `el-color-picker`...。
  - **拖拽接收目标**：`SpriteComponent` 的 `framePath` 输入框作为特定的 Drop Target（监听 `dragover` 和 `drop` 事件）。

## 5. 底部资源管理器 (Asset Pipeline)
- **图片过滤**：通过本地文件句柄读取，只过滤并显示当前项目目录下的图片文件（.png, .jpg, .webp），点击项目下文件夹时，可以只显示当前文件夹内的图片文件。
- **文件监听模拟**：实现一个【手动刷新/页面重新聚焦（Window Focus）时自动轮询】的机制，当检测到项目文件夹内图片增删时，资源管理器自动刷新。
- **资产拖拽**：支持从资源管理器拖拽图片，放置到右侧属性栏的 `framePath` 框中，释放后自动赋予该图片的**项目相对路径**。

# 四、 核心底层机制（数据流、同步与历史记录）

## 1. 单向数据流与防抖异步写入
- Pinia 中维护一个响应式的 `currentUIData` 状态源。UI 画布、节点树、属性栏的所有修改**必须立即更新**该状态源并触发视图重绘。
- 为了防止字符高频输入导致频繁写盘发生输入卡顿、光标丢失，更新本地磁盘 JSON 文件的操作必须经过 **300ms 的防抖（Debounce）处理**，或者在输入框触发 `blur`（失去焦点）事件时异步写入。

## 2. 撤销 / 重做机制 (Undo / Redo)
- 在 Pinia 中维护一个历史状态栈（History Stack），最大容量为 50 步。
- 凡是发生以下操作：**节点层级拖拽结束、添加/删除组件、输入框修改完成（Blur或回车时）、画布拖动结束、画布四角缩放结束**，均将旧的 `currentUIData` 镜像压入撤销栈。
- 支持全局快捷键 `Ctrl + Z`（撤销）和 `Ctrl + Y`（重做），触发时平滑刷新当前 UI 视图并异步同步至本地文件。

# 五、 PSD源文件导入与解析
- **PSD解析**：基于 `ag-psd` 实现高性能解析工具，准确解析图层组与像素图层（导出各层 PNG、透明度、显隐、包围盒与层级）。
- **PSD导入**：点击顶部【导入PSD】按钮选择 `.psd` 文件（CLI：`import-psd`，见第七节）；解析图层为图片写入项目，并创建同名 JSON 界面。例如源文件名为 `A.psd`，目录结构为：
  - `当前项目/A/UI/`：所有图层导出的 PNG 图片
  - `当前项目/A/A.json`：由图层树生成的 UI 界面
- **根节点与分辨率**：导入后 Root 宽高 = PSD 文档宽高，并同步编辑器设计分辨率。
- **尺寸与位置**：各节点 `width`/`height` 与 PS 图层像素尺寸一致（优先图层 `canvas` 宽高，与导出 PNG 一致）；`x`/`y` 由 PS 图层 `left`/`top` 换算为编辑器中心锚点（Root 中心为 `(0,0)`），保持与 PS 相同的屏幕位置，禁止额外缩放或取整偏移。图层组优先用 PS 组矩形，无效时用子节点并集；组内子节点为相对父节点的本地坐标。
- **透明度**：图层 opacity 规范为 `0–1` 后写入 `OpacityComponent`（完全不透明可不挂组件）。
- **图层顺序（重要）**：Photoshop 面板自上而下与引擎渲染顺序**相反**，但 `ag-psd` 读盘后的 `children` **已是引擎顺序（底层在前）**，创建节点时须**按该顺序直接生成，禁止再 `reverse`**，且禁止用 `zIndex` 控层。示例：面板自上而下为 `a → b → c → d → e（`e` 最下层）时，节点树须为 `Root → e → d → c → b → a`。图层组内同样按 `ag-psd` 顺序直出；组内子节点为相对父节点坐标。


# 六、 导出 Cocos Creator 3.x Prefab

## 1. 目标与入口
- 顶部【导出 Cocos Creator3.x Prefab】：将**当前打开的 UI JSON**导出为可直接拖入 Creator 的资源包（CLI：`export-prefab`，见第七节；CLI 用 `--ui` 指定 JSON，不依赖「当前打开」）。
- **目标引擎版本**：Cocos Creator **3.8.x**（Prefab / `.meta` 字段以该版本为准；若后续兼容其它小版本需单独声明）。
- **导出位置**：网页端用目录选择器选**独立导出目录**；CLI 用 `--out`（均不强制写回 UI 工程源目录），避免与编辑器用的 `framePath` 源文件混淆。
- 如界面为 `test.json`，导出目录结构为：
  - `{导出根}/test/UI/`：本 Prefab 用到的图片（及对应 `.meta`）
  - `{导出根}/test/test.prefab`：Cocos Prefab
  - `{导出根}/test/test.prefab.meta`：Prefab 的 meta
  - 各层文件夹均需生成目录 `.meta`

## 2. 资源与引用（UUID，非路径字符串）
- **只打包**当前 JSON 中所有 `SpriteComponent.framePath` **实际引用到**的图片；缺图时导出失败并提示缺失路径。
- Prefab 内 `cc.Sprite._spriteFrame` 必须引用 **SpriteFrame 的 UUID**（形如 `uuid@f9941`），**禁止**把 `framePath` 字符串直接写进 Prefab。
- 导出时为每张图片生成稳定 UUID（同路径同图多次导出尽量保持 UUID 不变，避免引用断裂），并写入：
  - `xxx.png` + `xxx.png.meta`（`importer: image`，含 `texture` / `sprite-frame` 子 meta）
  - Prefab 通过子资源 UUID 引用 `spriteFrame`
- 覆盖策略：目标已存在同名目录/文件时提示确认后覆盖。

## 3. 节点与组件映射
- 每个 JSON 节点 → `cc.Node` + `cc.UITransform`（`_contentSize` = width/height，锚点 `(0.5, 0.5)`）。
- `SpriteComponent` → `cc.Sprite`：写入 `_spriteFrame`、`_color`、`_type`、`_sizeMode`。
- `LabelComponent` → `cc.Label`：写入 `_string`、`_color`、`_fontSize`、`_lineHeight`、`_fontFamily`、`_enableWrapText`、`_isBold`、对齐 / `overflow` / `cacheMode`（标签字符串 → 引擎数值枚举）；系统字体 `_isSystemFontUsed: true`。
- `OpacityComponent` → `cc.UIOpacity`（opacity 为 `0–1`，写入引擎对应字段）。
- 无 Sprite / Label / Opacity 的节点仅保留 Node + UITransform。
- 节点 `_layer` 使用 **UI_2D**；根节点名称可用 JSON 根名（如 `Root`）。
- **枚举映射**：JSON 中的标签字符串须转为 Creator 数值枚举后再写入 Prefab：
  - `sizeMode`：`CUSTOM` / `TRIMMED` / `RAW` → `SizeMode` 对应数值
  - `type`：`SIMPLE` / `SLICED` / `TILED` / `FILLED` → `Sprite.Type` 对应数值
  - Label `horizontalAlign` / `verticalAlign`：`LEFT|TOP`=0、`CENTER`=1、`RIGHT|BOTTOM`=2
  - Label `overflow`：`NONE`/`CLAMP`/`SHRINK`/`RESIZE_HEIGHT` → 0–3；`cacheMode`：`NONE`/`BITMAP`/`CHAR` → 0–2
- **FILLED**：当前组件库未定义 fill 细分属性时，按默认填充即可；后续扩展再补 `fillType` / `fillRange`。
- Sprite 与 Label 同属 `componentType: 1`，同一节点不可同时挂载。

## 4. 坐标系与层级
- 编辑器/PSD 为 Y 向下，Cocos UI 为 Y 向上：导出时节点本地坐标 **`y = -y`**（与运行时 `ParseJsonUI` 一致）。
- `x`、宽高不翻转；旋转/缩放若暂无数据则按单位变换写出。
- 子节点顺序按 JSON `children` **原序**写入（底层在前、顶层在后），禁止再用 `zIndex` 重排。

## 5. Prefab 结构要求
- 输出标准 Creator 3.8 Prefab JSON 数组：含 `cc.Prefab`、各 `cc.Node`、组件、`cc.PrefabInfo` / `cc.CompPrefabInfo` 等必要对象，`__id__` 引用正确。
- 导出包拷贝进任意空 Creator 3.8 工程的 `assets` 后：无缺失引用报错，可直接在编辑器中打开 Prefab，层级、位置、贴图、Sprite 类型与尺寸模式与编辑器预览一致。

## 6. 边界与验收
- 图层/节点名需做文件系统安全处理（非法字符替换）；同名图片冲突时保留路径区分或重命名并同步更新引用。
- 验收清单：打开 Prefab 无红字 → 抽查带图节点 SpriteFrame 有效 → 抽查相对 Root 的位置（含 Y 翻转）→ 抽查 SLICED/TRIMMED 等枚举是否正确。
- 可选（非必须）：根节点挂 `Widget` 全屏适配；同目录附带原 JSON 便于对照；图集（Atlas）打包。
- **CLI**：须提供等价命令（见第七节），验收时 CLI 与网页导出结果在结构与引用上一致（UUID 可因实现而稳定同种子）。

# 七、 CLI 命令行（非 UI 批处理）

## 1. 目标与原则
- **范围**：只覆盖不依赖编辑器交互的批处理；画布编辑、节点树拖拽、Inspector、撤销重做、组件库可视化编辑等**不进 CLI**。
- **与网页共用核心**：PSD 解析、UI JSON 生成、Prefab / `.meta` 写出等须抽成**与浏览器 API 解耦**的纯逻辑（入参为路径 / Buffer / 虚拟 FS），网页端与 CLI 分别注入「读文件 / 写文件」实现，禁止两套算法分叉。
- **运行环境**：Node.js（建议 ≥ 18）；通过 `package.json` scripts 或 `bin` 入口调用（如 `npx uieditor …` / `npm run cli -- …`）。
- **退出码**：成功 `0`；参数错误 / 缺文件 / 解析失败等非 0，并向 stderr 输出可读错误。

## 2. 必须提供的命令

### 2.1 导入 PSD（对应顶部【导入PSD】）
```text
uieditor import-psd --psd <文件.psd> --project <项目根目录> [--name <界面名>]
```
- 行为与第五节一致：写入 `{项目}/{名}/UI/*.png` 与 `{项目}/{名}/{名}.json`。
- `--name` 默认取 PSD 文件名（去扩展名）；非法字符按 `sanitizeFsName` 处理。
- 若目标已存在：默认失败退出；可选 `--force` 覆盖。

### 2.2 导出 Cocos Prefab（对应顶部【导出 Cocos Creator3.x Prefab】）
```text
uieditor export-prefab --project <项目根目录> --ui <相对或绝对.json> --out <导出根目录> [--force]
```
- 行为与第六节一致：读取指定 UI JSON 及其 `framePath` 图片，写出 `{out}/{界面名}/` 资源包。
- 缺图、非法 JSON 须失败并列出路径。
- `--force`：覆盖已存在的同名导出目录；无此参数时已存在则失败。

### 2.3（建议一并提供）导出 / 校验 UI JSON
```text
uieditor export-ui --project <项目根> --ui <path.json> --out <目标.json>
uieditor validate-ui --ui <path.json>   # 校验 Root / 基础字段 / 组件结构合法性
```

## 3. 明确不提供 CLI 的能力
- 新建/导入项目的可视化挂载、画布横竖屏与分辨率对话框、节点增删改与拖拽、组件库 Modal 编辑、撤销重做等纯交互功能。

## 4. 实现与目录建议
- 核心库：如 `src/core/` 或 `src/utils/` 中与 DOM / Pinia 无关的模块（`psd` 解析、`cocosPrefab` 构建等）。
- CLI 入口：如 `UIEditor/cli/` 或 `scripts/cli.ts`，使用 `fs/promises` + `path` 实现读写，复用上述核心。
- 网页端继续用 File System Access API；**禁止**在 CLI 中依赖 `showDirectoryPicker` / `window`。

## 5. 验收
- 同一 PSD：CLI `import-psd` 与网页【导入PSD】生成的 JSON 树结构、坐标、图片集合一致（允许 `_id` 等运行时字段差异）。
- 同一 UI JSON：CLI `export-prefab` 与网页【导出 Prefab】的目录结构、图片清单、Prefab 节点层级与 `y = -y` / 枚举映射一致。
- `uieditor --help`（或等价）列出上述子命令与参数说明。