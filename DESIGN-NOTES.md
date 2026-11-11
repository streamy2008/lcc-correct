# 设计说明 · LCC 校正 PWA

配套文件：`app/tokens.css`（纯 CSS 自定义属性，无组件样式）

---

## 1. 选用的风格

| 项 | 值 |
| --- | --- |
| 技能 | `awesome-design-md` |
| 索引 | `STYLE_INDEX.txt` 第 27 行 `linear.app` |
| 风格文件 | `design-md/linear.app/DESIGN.md`（548 行，全部读完） |
| 为什么选它 | Linear 是这套参考库里最「软件工艺 / 专业技术工具」的一支：单一彩色强调色、四阶表面梯、发丝描边、等宽字体承载数值、明确拒绝渐变与玻璃感与第二彩色。影像处理工作台的界面应该退到照片后面去，正好对得上。 |

排除项：vercel 的装饰系统是英雄区的多色渐变，stripe 只有亮色一套且按钮用胶囊——都与「不要大面积渐变 / 要克制」冲突。

---

## 2. 直接取自 `linear.app/DESIGN.md` 的取值

暗色档基本是它的原值（括号内是该文件的 token 名）：

| 本文件 token | 值 | 来源（DESIGN.md） |
| --- | --- | --- |
| `--c-bg`（暗） | `#010102` | `colors.canvas` |
| `--c-surface-1/2/3`（暗） | `#0f1011` / `#141516` / `#18191a` | `colors.surface-1/2/3` |
| `--c-line`（暗） | `#23252a` | `colors.hairline` |
| `--c-ink` / `--c-ink-muted` / `--c-ink-subtle`（暗） | `#f7f8f8` / `#d0d6e0` / `#8a8f98` | `colors.ink` / `ink-muted` / `ink-subtle` |
| `--c-ink-faint`（暗） | `#62666d` | `colors.ink-tertiary` |
| `--c-accent` | `#5e6ad2` | `colors.primary`（Linear 招牌紫蓝） |
| `--c-accent-hover`（暗） | `#828fff` | `colors.primary-hover` |
| `--c-accent-press`（暗） | `#5e69d1` | `colors.primary-focus` |
| `--c-on-accent` | `#ffffff` | `colors.on-primary` |
| `--c-ok`（暗） | `#27a644` | `colors.semantic-success` |
| `--c-line-strong`（暗） | `#62666d` | `colors.ink-tertiary`（改用作 ≥3:1 控件描边） |
| `--f-h1` / `--f-h2` / `--f-label` / `--f-mono` / `--f-body` / `--f-small` | 28 / 22 / 13 / 13 / 16 / 14 px | `typography.headline` 28、`card-title` 22、`eyebrow` 13、`mono` 13、`body` 16、`body-sm` 14 |
| `--f-w-regular/medium/semibold` | 400 / 500 / 600 | 该文件明确「拒绝 700 以上」 |
| `--s-1/2/3/4/6/8/12/16` | 4/8/12/16/24/32/48/64px | `spacing.xxs/xs/sm/md/lg/xl/xxl`（`--s-5` 20、`--s-7` 28、`--s-9` 36、`--s-10` 40、`--s-20` 80 是我在同一 4px 网格上补齐的档） |
| 深度策略 | 抬升靠表面梯 + 发丝描边，不靠投影 | `Elevation & Depth`（「brand resists drop shadows on dark almost entirely」） |
| 强调色用法 | 只用于主按钮、焦点环、链接、品牌标记 | `Do's and Don'ts` |

**不是它给的、我自己定的部分（如实标注）**

- **亮色整套**：`linear.app/DESIGN.md` 只发布暗色（其 `Known Gaps` 原文：「Light mode is not documented because the marketing site does not ship a light theme」）。亮色档是我用它的 `inverse-canvas #ffffff` / `inverse-surface-1 #f5f6f6` / `inverse-surface-2 #f6f7f7` / `inverse-ink #000000` 起手，再按 4.5:1 重算出来的，不是文件原值。
- **warn 琥珀、err 红**：该文件明说「the only semantic color is `semantic-success`」，所以这两色是我补的并按对比度标定。`info` 不另起彩色，直接复用强调色同族（保持「单一彩色」原则）。
- **圆角 6/10/14**：按你的硬性要求，覆盖了 Linear 的 4/6/8/12/16 梯。
- **两档阴影、图像底色、棋盘格、遮罩**：文件里没有，按「克制」原则自定。

---

## 3. 字号与字体（rem，基准 16px）

- 正文 `--f-body: 1rem`。**218ppi 的 Studio Display 上正文不得低于 1rem**，`--f-small`（14px）只做次要说明、`--f-label`（13px）只做控件标签，都不承载正文。
- 手机主操作按钮与数值大读数用 `--f-body-lg`（17px）。
- 中文正文：`--f-stack-serif: 'Source Han Serif SC','Songti SC',serif`。
- 数值 / 等宽：`--f-stack-mono` 前三位是 `'SF Mono',ui-monospace,Menlo`，**末尾接 CJK 衬线而不是 `monospace`**——否则中文元数据会掉进系统黑体（PingFang），破坏「中文一律衬线」的规则。
- 增益、像素数、耗时一律用 mono 栈 + `font-variant-numeric: tabular-nums`，数字跳变时列宽不抖。
- **两条字体栈都实机验证过**（Chromium + CDP `CSS.getPlatformFontsForNode`，看的是真实渲染字体而不是 CSS 声明）：中文正文落在 `Source Han Serif SC`；mono 栈里的中文（如「增益」）**也落在 `Source Han Serif SC`，没有掉进 PingFang**；mono 栈里的拉丁数字落在 `Menlo`（本机未装 SF Mono，栈内下一档接住，符合预期）。

---

## 4. 无障碍与触控（数字都是我实算的 WCAG 2.1 相对亮度公式，不是估的）

**正文 / 次级 / 元信息（要求 ≥ 4.5:1）**

| 组合 | 亮色 | 暗色 |
| --- | --- | --- |
| `--c-ink` on `--c-bg` | **17.02:1** | **19.61:1** |
| `--c-ink` on `--c-surface-1` | **18.11:1** | **17.90:1** |
| `--c-ink-muted` on `--c-surface-1` | **9.39:1** | **13.04:1** |
| `--c-ink-subtle` on `--c-surface-1` | **5.65:1** | **5.86:1** |
| `--c-ink-subtle` on `--c-surface-2` | **5.08:1** | **5.63:1** |

**四种状态色（文字专用档，要求 ≥ 4.5:1）**

| 状态 | 亮色文字 on 卡片 / on 柔底 | 暗色文字 on 卡片 / on 柔底 |
| --- | --- | --- |
| ok | 6.04:1 / 5.32:1 | 8.56:1 / 7.34:1 |
| warn | 6.33:1 / 5.66:1 | 9.40:1 / 7.89:1 |
| err | 6.54:1 / 5.72:1 | 6.36:1 / 5.76:1 |
| info | 6.07:1 / 5.27:1 | 6.64:1 / 5.71:1 |

**按钮与控件（非文本要求 ≥ 3:1）**

| 组合 | 亮色 | 暗色 |
| --- | --- | --- |
| 白字 on `--c-accent` 主按钮底 | 4.70:1 | 4.70:1 |
| `--c-accent-ink` on 卡片 / on `--c-bg` | 6.07:1 / 5.71:1 | 6.64:1 / 7.27:1 |
| `--c-line-strong` 控件描边 on surface-1 / surface-2 | 3.99:1 / 3.59:1 | 3.30:1 / 3.17:1 |
| `--c-focus` 焦点环 on surface-1 | 4.70:1 | 6.64:1 |

**结论：无一不达标。** 两点需要你知道的边界：

1. `--c-line`（发丝分隔线）只有 **1.33:1（亮）/ 1.24:1（暗）**，这是装饰线、按 Linear 的做法故意做到几乎看不见。**凡是「必须看清边界」的地方（输入框、下拉、卡片可点击区域）请用 `--c-line-strong`（≥3.17:1），不要用 `--c-line`。**
2. `--c-ink-faint`（3.14:1 / 3.30:1）**只允许用在 disabled 元素上**，WCAG 对禁用控件豁免对比度。

**触控目标：最小 44×44px**，由 `--s-touch: 2.75rem` 表达；控件默认高度 `--s-control-h: 2.75rem`。桌面可压到 `--s-control-h-desk`（36px，鼠标场景），**手机端任何可点元素不得低于 `--s-touch`**。手机底部两个主按钮另加 `--s-safe-bottom` 避让 Home Indicator。

---

## 5. 用法约定（只给规则，不写组件样式）

| 界面部位 | 用哪几个 token |
| --- | --- |
| 页面底 / 顶栏 | `--c-bg`；顶栏下边 `1px var(--c-line)` |
| 状态徽标（在线/离线） | 在线 `--c-ok`、离线 `--c-warn`（离线不是错误，别用红）、失败 `--c-err`、提示 `--c-info`；文字一律取对应 `*-ink` |
| 图像预览区 | 底用 `--c-image-mat`（明暗两套都是近黑，避免界面底色干扰看片判断）；透明区用 `--c-checker-a/b`；容器圆角 `--r-3` |
| 前后对比滑块 | 分隔手柄 `--c-accent`，标签底 `--c-overlay`，文字 `--c-image-mat-ink` |
| 控制面板 / 平场列表卡片 | 底 `--c-surface-1`，描边 `var(--c-line)`，圆角 `--r-2`，阴影 `--sh-1`（平场缩略图用 `--r-1`） |
| 文件导入区（可拖放） | 常态描边 `--c-line-strong`（保证 3:1）；拖入悬停改为 `2px dashed var(--c-accent)` + 底 `--c-accent-soft` |
| 滑块（强度/平滑） | 未填充 `--c-track`，已填充与拇指 `--c-accent`，焦点环 `--c-focus` |
| 下拉（模型） | 底 `--c-surface-2`，描边 `--c-line-strong`，浮层阴影 `--sh-2`、圆角 `--r-2` |
| 按钮 | 主：`--c-accent` 底 + `--c-on-accent` 字；次：`--c-surface-1` 底 + `--c-ink` 字 + `--c-line` 描边；危险：`--c-err-soft` 底 + `--c-err-ink` 字 |
| 数值读数（增益/像素/耗时） | mono 栈 + `--f-mono` + `--c-ink-subtle`；关键数值升到 `--c-ink` |
| 手机底部操作条 | 底 `--c-surface-1` + 上边 `--c-line`，按钮高 `--s-touch`，下内边距含 `--s-safe-bottom` |

布局断点建议：**≥ 960px 走两栏**（左预览 `minmax(0, 1fr)`、右面板 `clamp(320px, 28vw, 400px)`），**< 960px 单列堆叠**，底部操作条仅窄屏出现。桌面两栏间距用 `--s-panel-gap`；页面左右内边距一律 `--s-page-x`。

过渡：只用于 hover/press/展开收起，`--t-fast`（100ms）给按钮与滑块，`--t-base`（160ms）给浮层与面板，`--t-slow`（240ms）给状态色切换；曲线用 `--t-ease`。**不要给图像预览加过渡**（会让对比滑块拖起来发飘），并尊重 `prefers-reduced-motion`。

### 兼容别名（临时，可整体删除）

并行开发中的 `styles.css` 是在 `tokens.css` 还是占位文件时写的，用了 7 个不在正名清单里的短名字（另有 `--s-7`，我直接补成正规档位）。我在 `:root` 末尾加了一小段别名，**值全部是指向正名的 `var()`，没有复制任何色值**，所以明暗两套自动跟随，改正名不用改两处：

| 别名（styles.css 在用） | 指向的正名 |
| --- | --- |
| `--c-surface` | `--c-surface-1` |
| `--c-muted` | `--c-ink-muted` |
| `--c-ink-2` | `--c-ink-muted` |
| `--c-line-2` | `--c-line-strong` |
| `--font-body` | `--f-stack-serif` |
| `--font-mono` | `--f-stack-mono` |
| `--t` | `--t-base` |

`--s-7`（28px）不是别名，是我为把间距阶梯补齐成 1–12 连续而新增的正规档位。

**已实测**：现有 `styles.css` 一共用到 35 个变量名，在真实页面上逐个取 `getComputedStyle` 读数，亮/暗两套**无一落空（missing = []）**。等 `styles.css` 把上面 7 个名字改成正名，删掉别名段即可，不会有任何视觉变化。

### 一处刻意的例外

`tokens.css` 里出现了一条非自定义属性声明：`:root { color-scheme: light }`，暗色块内改为 `dark`。它只在 `:root` 上、不是组件样式，作用是让原生 `<select>`、`<input type="file">`、滚动条跟随主题——否则暗色界面里会冒出白色的下拉列表和文件选择器。若你要求文件里 100% 只有自定义属性，删掉这两行即可，其余 token 不受影响。

---

## 6. 自查结果

- `--c-*`：亮色 **42** 个、暗色 **42** 个，**变量名两套完全一致（双向差集为空）**；其中 4 个是上面说的兼容别名。其余 `--s-*` 19 个、`--f-*` 21 个、`--r-*` 4 个、`--sh-*` 2 个、`--t-*` 5 个。
- 文件内除 `:root` 与 `@media (prefers-color-scheme: dark)` 外**没有任何选择器**，没有引入字体文件、图片、网络资源，没有一行 JS。
- 全部颜色对已按 WCAG 2.1 公式逐对实算，见第 4 节表格。
- 真机验证（Chromium 无头，`color-scheme: light` / `dark` 两个上下文）：`:root` 上的 token 全部读到预期值；`var()` 在真实元素上解析成功（`--r-2` → `10px`、`--f-body` → `16px`）；暗色上下文正确覆盖为 `--c-bg: #010102`。
- 字体栈用 CDP `CSS.getPlatformFontsForNode` 查真实渲染字体：中文 → `Source Han Serif SC`，mono 栈里的中文也是 `Source Han Serif SC`（没掉 PingFang），数字 → `Menlo`。

