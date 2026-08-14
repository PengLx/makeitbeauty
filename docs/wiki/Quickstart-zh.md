# 组件开发快速上手（中文）

MakeItBeauty（[makeitbeauty.org](https://makeitbeauty.org)）的组件是**可复用、可传参的设计片段**，其他用户把它作为 `instance` 节点放进自己的卡片设计里。本页帮你在十分钟内理解全貌；深入细节请读英文页（本页末尾有目录）。

## 两种组件

| | 声明式（默认） | 代码式（`kind: "code"`） |
|---|---|---|
| 本体 | 一份 JSON 节点片段，带 `{{props.*}}` 插槽 | 一个纯函数 `render({props, frame}) => nodes` |
| 适合 | 徽章、卡片、横幅、进度条——手工能摆出来的布局 | 热力图、迷你图表——每个数据项都要算坐标的可视化 |
| 取数方式 | `{{props.*}}` 模板（仅限文本内容和颜色） | 只有 `props` 对象（含原始 `series` 数组） |
| 节点上限 | 声明节点 ≤ 64 | 每次渲染输出 ≤ 512 |
| 执行环境 | 不执行任何代码 | 无能力 QuickJS-in-WASM 沙箱（约 50ms CPU / 32MB） |

## 通用概念

- **命名空间**：就是你的 GitHub 登录名（小写），组件 id 形如 `{owner}/{name}`；`kit/` 保留给官方组件。
- **生命周期**：草稿（私有、可改）→ 发布（冻结为不可变的 `{owner}/{name}@{n}`，版本号自增）→ 社区浏览。设计引用的是**固定版本**，升级由设计作者自己选择——平台规则禁止静默自动更新。下架（unlist）只是从浏览中隐藏，已固定引用的设计照常渲染。
- **frame**：组件自己的坐标系 `{w, h}`。实例化时按 `s = min(实例w/frame.w, 实例h/frame.h)` 等比缩放、左上对齐——组件永远不会被拉伸变形。
- **props**：最多 32 个插槽，类型为 `string`、`number` 或 `series`（JSON 数组），**必须带同类型的默认值**。默认值同时用于：实例省略该 prop 时的取值、调色板悬停预览、以及代码组件的发布校验输入。

## 三条铁律（每个发布检查都会碰到）

1. **只能通过 props 取数。** 组件里的模板只允许 `{{props.*}}`；写 `{{github.…}}` 会被直接拒绝。连接器数据必须由设计作者绑定到 prop 上再进入组件——这保证了"这张图会公开显示什么"的知情记录始终真实。
2. **只能用内置字体。** 目前是 Inter、JetBrains Mono、Lora（各含 400/700 字重），且必须写字面量——用模板绕过检查同样会被拒绝。用户上传的字体是私有的，永远不随组件发布。
3. **绝不允许外部 URL。** 图片只能是 `data:` URI，颜色里不能出现 `url(`，最终 SVG 还有净化器兜底。这是安全边界（外链 + 连接器数据 = 数据外泄信标），不是风格建议。

## 路线一：声明式组件

在编辑器的 **Components** 区点击 **New component** 新建组件，然后在 Component Studio 里声明 props、摆节点。一个完整可发布的例子：

```json
{
  "id": "you/status-badge",
  "title": "Status badge",
  "category": "decor",
  "frame": { "w": 240, "h": 56 },
  "props": {
    "text":   { "type": "string", "default": "open to work" },
    "accent": { "type": "string", "default": "#3fb950" }
  },
  "nodes": [
    { "id": "pill", "type": "rect", "x": 0, "y": 0, "w": 240, "h": 56,
      "style": { "fill": "#161b22", "radius": 28, "stroke": "{{props.accent}}", "strokeWidth": 1 } },
    { "id": "dot", "type": "rect", "x": 20, "y": 22, "w": 12, "h": 12,
      "style": { "fill": "{{props.accent}}", "radius": 6 },
      "animation": { "preset": "pulse", "durationMs": 1800, "loop": true } },
    { "id": "caption", "type": "text", "x": 44, "y": 18, "w": 176, "h": 20,
      "text": "{{props.text}}", "style": { "fontSize": 14, "color": "#e6edf3" } }
  ]
}
```

要点：

- 节点只有 `text` / `rect` / `image` 三种（组件里不能再嵌 `instance`），坐标相对 frame 左上角。
- `{{props.*}}` 只在**文本内容和颜色**里生效；几何字段（x/y/w/h 等）是数字类型，写不了模板。
- 想让数字 prop 驱动几何，用 `computed` 线性映射（进度条的典型写法）：`{ "node": "fill", "prop": "percent", "field": "w", "scale": 4.4, "clamp": [0, 440] }`，即 `fill.w = clamp(percent × 4.4, 0, 440)`。它刻意不是表达式语言。
- 动画共 8 个预设：`fadeIn`、`pulse`、`float`、`growX`、`growY`、`slideUp`、`slideLeft`、`blink`。默认只播一次；循环类（`pulse`/`float`/`blink`）记得显式 `"loop": true`。
- `tw` 工具类（渐变、阴影、圆角等 Tailwind 子集）可以给节点加视觉效果，但 **`tw` 是定义内静态的**——不要往里塞模板；需要 prop 驱动的颜色走 `style.color` / `style.fill` / `style.stroke`（它们会覆盖 `tw`）。

## 路线二：代码组件

当"每个数据项都要算位置"时（比如贡献热力图的 371 个格子），用代码组件。契约只有一条：

```js
function render({ props, frame }) {
  // props: 声明的 props（series 类型是原始 JSON 数组）
  // frame: { w, h } —— 你自己的坐标系
  return [ /* text/rect/image 节点数组，坐标相对 frame */ ];
}
```

- **必须同步返回**，没有 async，没有网络，没有 `Date`，没有 `Math.random`——沙箱在运行时层面强制确定性，发布时还会**执行两次并逐字节比对输出**。
- 资源上限：约 50ms CPU、32MB 内存、输出 ≤ 512 个节点 / 512KB，源码 ≤ 64KB（按 UTF-8 字节计——中文注释一个字最多占 3–4 字节）。
- 违规的结果是：发布时被拒绝；渲染时降级为占位虚线框加警告——**永远不会弄坏别人的卡片**。
- `console.log` 会被捕获（最多 32 条、每条 ≤ 512 字符），在 Studio 预览下方和发布结果里显示，这是你唯一的调试输出。
- `series` prop 是数组进入组件的唯一通道：设计作者用单一模板 `"{{github.stats.calendar}}"` 绑定，组件收到的是**原始数组**（绝不会被转成字符串）。
- 输出节点同样受铁律约束：唯一 id、内置字体、`data:` 图片；可以带动画预设。

编辑器的 **New component** 对话框里有 **Code: Contribution heatmap** 起步模板——一个用 `series` prop 画 371 个格子的完整热力图，直接可发布，是最好的学习样本。逐段讲解见英文页 [Code Components](./Code-Components.md)。

## 发布前自查清单

- [ ] 所有 `{{…}}` 都是 `{{props.*}}`？（注意：`description` 等纯文本里也不能出现别的 `{{…}}`）
- [ ] `fontFamily` 只有字面量的 Inter / JetBrains Mono / Lora？
- [ ] 图片全是 `data:` URI？
- [ ] 每个 prop 的默认值类型正确、有代表性？（代码组件会拿默认值跑发布校验和预览）
- [ ] 节点 id 唯一？没有嵌套 `instance`？
- [ ] 代码组件：纯函数、同步返回、没碰 `native`/`dataFields`/`computed`？

## 深入阅读（英文）

- [Home](./Home.md) —— 全貌与安全模型
- [Declarative Components](./Declarative-Components.md) —— 声明式格式的每个字段
- [Code Components](./Code-Components.md) —— 沙箱规则、错误码表、热力图逐段讲解
- [Publishing and Versions](./Publishing-and-Versions.md) —— 发布校验与常见拒绝信息原文
- [Using Components](./Using-Components.md) —— 使用者视角：调色板、绑定、版本固定

---

Next: [Home](./Home.md)
