# GreyWork UI Design Guidelines

This document defines the visual design language for GreyWork. The canonical implementation lives in `@greywork/workbench/src/theme/` — specifically `tokens.css` (CSS custom properties) and `token-contract.ts` (the TypeScript contract that validates them).

## Design Philosophy

- **Dark-first**: Dark mode is the default appearance. The shell writes `data-theme="dark"` on first frame to prevent flash.
- **Near-black canvas**: OLED-friendly pure black (`#000000`) base with 5-level grayscale layering (`bg-base → bg-1 → bg-2 → border`). Cards and surfaces gain depth through elevation, not borders.
- **Blue-primary, violet-brand**: Primary actions use blue (`#4d9fff` dark / `#165dff` light). The GreyWork brand color is violet (`#a1aacb` dark / `#7583b2` light) — used only for brand elements, not primary actions.
- **Color restraint in chat**: Chat surfaces (bubbles, tips panels, thought panels) are all neutral black-gray. Color appears only in Agent identity avatars (`--grey-*`), status signals, and semantic tokens.

## Theme Structure

### Token Categories

Tokens are grouped into semantic categories (mirrored in `token-contract.ts`):

| Group        | Purpose                                        |
| ------------ | ---------------------------------------------- |
| `background` | Canvas, panels, surfaces, paper                |
| `text`       | Primary, secondary, tertiary text              |
| `border`     | Input/output borders, dividers                 |
| `semantic`   | Status signals (warning, info, success, error) |
| `brand`      | GreyWork brand color + Agent identity colors   |
| `accent`     | Primary action color + hover states            |
| `special`    | Font families (not user-overridable color)     |

### Available Palettes

Six palettes are defined:

1. **`greywork`** (default) — Dark-first, near-black, blue primary, violet brand
2. **`github`** — GitHub-inspired code workbench, green primary
3. **`fox`** — Warm terracotta, orange primary
4. **`night-blue`** — Blue-tinted dark, blue primary
5. **`night-green`** — Green-tinted dark, green primary
6. **`liquid-glass`** — Translucent frosted-glass surfaces, blue primary

Each palette has `light` and `dark` variants.

### Token Scoping

- **Appearance-invariant tokens**: Same value in both light and dark mode (e.g., `--console`, `--grey-*`, fonts). Defined once on `:root`.
- **Appearance-scoped tokens**: Different values in light vs. dark mode. Defined on `:root` (light) and overridden in `:root[data-theme="dark"]`.
- **Structure tokens** (`--gw-*`): Layout variables (sidebar width, topbar height, etc.) — not theme-overridable.

## Layout

```
--gw-sidebar-w: 260px      /* Left navigation rail */
--gw-topbar-h: 56px        /* Top app bar */
--gw-side-w: 420px         /* Right property panel (520px on ≥1600px) */
--gw-statusbar-h: 24px     /* Bottom status bar */
```

### Shell（恒定极简）

There is exactly one shell — no mode toggle, no full-shell alternative. The chrome is fixed:

- **Sidebar** — `features/shell/MinimalSider.vue`: a slim sidebar with quick entries
  (`lib/nav-items.ts`) and the session history. It deliberately omits the full `Sider`'s collapse
  rail, brand toggle, `SiderRegions` (plugin sidebar groups) and `CoworkSiderSection` (cowork run
  nesting). Collapse/expand lives in the titlebar's left toggle; on narrow viewports the sidebar
  starts collapsed and opens as an overlay drawer.
- **Titlebar** — `features/shell/Titlebar.vue`: one unconditional cluster on the left (sidebar
  toggle / search / GitHub / update) and one panel cluster on the right (preview / workspace /
  terminal), plus the workspace pill and the window controls. Panel toggles use **panel glyphs**
  (`sidebar` / `sidebar-right` / `terminal` from `lib/icons.ts`), never arrows — the state is
  carried by the aria-label. The sidebar toggle is gated by the front's `shell.panels.sider`
  declaration; each panel toggle by its store's `available`.
- **Composer** — on `/guid` **and** on `/conversation/:id` the composer is the streamlined
  `features/guid/MinimalComposer.vue` card (workspace chips + textarea + action row, plus a
  separate `AcpSessionConfig` block under it when routed to ACP), driven by each view's existing
  dispatch pipeline.
- **Panels** — preview / workspace / terminal are retained, each with its own titlebar toggle.
  The activity band is not rendered: the plugin `activityPanel` regions have no host.

The center stays the router view. All four panel shortcuts (`Ctrl/Cmd+B` / `E` / `\` / `` ` ``)
work unconditionally; the layout-mode shortcuts (`Ctrl/Cmd+1..4`) still drive the two panel
visibilities through `lib/layout-modes.ts`.

## Typography

- **UI / Display**: Archivo Variable (DIN-style industrial grotesque with width axis for label tags)
- **Code / Metrics**: JetBrains Mono
- **Chinese fallback**: Noto Sans SC / Microsoft YaHei / system-ui

Font size: 15px base.

## Component Conventions

- Use **shadcn-vue components** as the foundation. They live in `packages/workbench/src/components/ui/`
  (vendored source — the project owns and edits them).
- **Add components only via `pnpm shadcn:add <names>`**. It runs the CLI against
  `packages/workbench` (so aliases resolve to `@/components/ui`) and then `scripts/shadcn-sync.mjs`.
  Calling `pnpm dlx shadcn-vue` directly skips the required localizations and will produce
  components that fight this project's theme:
  1. `-accent` → `-secondary` — see the note below.
  2. Overlay `bg-black/80` → `bg-black/40` (matches the pre-existing hand-rolled dialogs).
  3. `defineSlots` 里的 `=> any` → `=> unknown`（ESLint 禁 `any`）；`TooltipContent` 的紧凑皮肤
     也在同一条规则表里收口。新增冲突时改 `scripts/shadcn-sync.mjs` 的规则表而不是手改组件——
     下次 `shadcn:add` 会把上游原文再写回来。

  图标包**不再需要改写**：仓库从 2026-09-29 起直接用 `@lucide/vue`（上游的 `lucide-vue-next`
  已 deprecated 并指向它），与 shadcn 的产出一致，所以规则表里的那条改写已删除。

- **`--accent` means GreyWork blue, not a hover surface.** `tokens.css` defines `--accent` as the
  brand action color (~110 call sites). shadcn uses `accent` for hover/selected states, so vendored
  components are rewritten to use `--secondary` (= `--panel-2`), which is the correct hover-surface
  token here. Do not introduce `bg-accent`/`text-accent` into `components/ui/`.
- **`dark:` resolves via `[data-theme="dark"]`**, configured by `@custom-variant dark` in
  `apps/desktop/src/tailwind.css`. Never assume `prefers-color-scheme`; the app's light/dark is
  independent of the OS.
- Prefer shadcn primitives for **behavior** (portal, focus trap, ARIA, scroll lock) while keeping the
  project's **compact visual skin** — 12–13px type, 14px dialog radius, `panel`/`line` tokens.
  shadcn's `text-lg` / `max-w-lg` / `p-6` defaults read as oversized next to this UI.
- **Never hardcode** theme tokens — always use CSS variable references from `tokens.css`
- New color tokens must be registered in `token-contract.ts` and will be validated by `token-contract.test.ts`
- Status signals should use the semantic token set (`--amber`, `--cyan`, `--violet`, `--mint`, `--orange`)
- Agent-specific accent colors use the `--grey-*` family (blue, green, orange, violet, red)
- **业务按钮用 `features/shared/GwButton.vue`**（`variant` ghost/subtle/secondary/outline/primary/danger，
  `size` xs/sm/md + icon-xs/icon/icon-lg，`radius` sm–xl/full）。它用项目配方（`gw-button-variants.ts`）
  而非上游 `components/ui/button`，base 自带焦点环 / disabled / 过渡；一次性样式叠 `class`。详见下方
  「刻意不迁移」里的 `Button` 条。

### 提示（tooltip）：用 `features/shared/Hint.vue`，不要用原生 `title=`

```vue
<Hint text="导出为 JSON"><button …>…</button></Hint>
```

- `text` 传 `null` 即透传插槽，所以条件文案不必在调用点写 `v-if`。
- **`Hint` 自带 `TooltipProvider`，不要另外挂全局 provider。** reka 的 `TooltipRoot` 拿不到
  provider 上下文时直接抛（抛点在 reka 的 `createContext.ts`），全局挂法会让「哪些测试要多包一层」
  变成隐式耦合 —— 连祖先组件的测试都会炸。取舍见 `Hint.vue` 顶部注释。
- **只有当提示本身是在解释「为什么不能用」时**，才把触发器的 `disabled` 换成 `aria-disabled`：
  原生 `disabled` 的元素收不到指针事件，提示永远弹不出来。换用 `aria-disabled` 后必须确认
  点击处理器自带守卫。按钮只是瞬时忙（执行中）而提示讲的是「点了会做什么」，照常用 `disabled`。
- **弹层有 320px 上限**（`TooltipContent` 基类里的 `max-w-[320px]`，由 `shadcn-sync.mjs` 的
  `tooltip-skin` 规则落盘）。上游只给 `w-fit`，长文案（完整路径、报错原文）会被拉成一条超出屏幕的窄条；
  封顶后长文案自己换行，短文案仍是单行贴内容宽。`multiline` 只再补 `overflow-wrap:anywhere`：
  正常句子按词断，只有没有空格的整串（路径 / URL / id）才逐字符断 —— 别用 `break-all`，那会把英文单词劈开。
- `<iframe>` 上的 `title` **不是** tooltip，是 iframe 的可访问名 —— 不要迁。
- 测试里查提示内容要 `await trigger("focus")` + 查 `document.body` 的
  `[data-slot="tooltip-content"]`；它的 `textContent` 含 reka 的 1px 隐藏测量副本（文本出现两遍），
  所以断言用 `toContain`，不要用 `toBe` 精确比对。

### 刻意**不**迁移的部分（附理由，避免重复分析）

- **业务按钮不走上游 `Button`，改用 `features/shared/GwButton.vue`。** 不迁的是**上游
  `components/ui/button` 的 `buttonVariants()`**：它的基类只在调用点 class 冲突时才被 twMerge 消掉，
  不冲突就原样生效，实测后果 `[&_svg:not([class*='size-'])]:size-4` 把 **86 个**图标强制 16px
  （`Icon.vue` 用 `width`/`height` **属性**，CSS 覆盖属性）、默认 `h-9` 影响 **139 个**、
  `bg-primary` 影响 **137 个**。整串去重也低（原生 `<button>` 约 160 个不同 class 串，仅 31 串复用）。
  但**组合**上杠杆很大：实测 371 个带 class 的原生按钮里，焦点环（`focus-visible:outline-cyan` 一组）
  重复 94 次、ghost 文字（`text-dim hover:text-foreground`）169 次、`cursor-pointer`/`transition-colors`
  各 260+、primary（`bg-accent text-accent-ink`）37 次。所以收口方式不是复用上游配方，而是
  **自带一份项目配方** `gw-button-variants.ts`（同机制 cva + reka `Primitive` + `cn`，但 base 只收
  普适有益的行为、视觉由 `variant·size·radius` 三轴表达，无上游冲突默认值）。调用点的一次性 class
  原样塞 `class`（twMerge 后者胜）；带 logo 的品牌入口这类真正异形的不强迁。上游 `Button` 仅在
  shadcn 组件要求处（弹窗底部动作）使用，并逐个核对 twMerge。
- **`<select>` 保持原生。** 原生 select 的可访问性/键盘行为由平台保证，换成 reka Select 是降级。
- **原生复选框保持原生。** 同 `<select>`：标签点击激活、表单语义、键盘都由平台保证；reka 的 `Checkbox`
  是 `role="checkbox"` 的按钮，换过去没有行为收益，却把「点整行文字也切换」押在各引擎的 label 激活实现上。
  统一写法 `class="size-4 cursor-pointer accent-[var(--accent)]"`（8 处已对齐），没有可见文案的补 `aria-label`。
- **`AcpModelSelector` 暂不迁 `Popover`+`Command`。** 它的方向键导航只在用 `CommandInput`
  （即 reka 的 `ListboxFilter`，负责把输入框的方向键转发进 listbox）时才生效，而那样会连带把
  过滤换成 Command 自己的 `contains(textContent, search)` —— 为保住现有「同时匹配显示名与 value」
  还得额外塞 `sr-only` 副本和一个读 `useCommand()` 的计数子组件。它是唯一一个搜索/Esc/点外关闭
  本来就能用的手写菜单，收益最低、风险最高。
- **`AcpModelSelector` 是最后一处手写「元素锚定」浮层**（`lib/panel-placement.ts` 仍只有它一个消费者）。
  `SearchPanel` 已迁到 `Popover`：`<Popover>` 由 `Titlebar` 持有、`SearchPanel` 只出
  `PopoverContent`，`lib/use-floating-panel.ts` 因此失去唯一消费者。
  迁这类浮层的要点：内容 Portal 到 body，测试不能再靠 `wrapper.find`，要用 `DOMWrapper` 查
  `document.body`，且 `attachTo` 之后必须显式 `unmount()`（直接清 `innerHTML` 会让 Vue 卸载时
  报找不到父节点）；另外 Esc / 点外部只会关掉 Popover 让父级 `v-if` 卸下面板，**不会** emit
  `close` —— 断言要查「面板没了」而不是查事件。

- **`SelectionToolbar`（划词工具条）保留手写。** 它锚的是**选区矩形**而非元素，reka Popover 得走 virtual
  reference；而 Esc / 点外部收起 / 上翻下夹已由 `SelectionLayer` + `lib/selection.ts` 覆盖并有测试，
  换过去只剩「焦点与选区保持」的返工风险（`@mousedown.prevent`、按下期间抑制捕获都是刻意的）。
- **`SlashCommandMenu` 保留手写。** 焦点始终留在 textarea、高亮走 `aria-activedescendant`；`Command` 的
  方向键导航依赖 `CommandInput`（会把焦点搬进弹层），过滤也会跟着换成语义不同的实现。
- **预览查看器与 Markdown 里的原生 `<table>` / `<hr>` 是内容渲染**（docx / pptx / markdown 的忠实还原），
  不是 UI 组件，不迁。

### 迁移状态（2026-09）

已完成：底座（30 个组件 / 148 文件）、8 处手写弹窗（6 处迁到 `dialog` / `alert-dialog`；`PermissionCard`
改内联 `role="group"`——它本就不是模态；`UnsavedChangesDialog` 随功能删除）、3 个菜单（`dropdown-menu`）、
约 58 处 `title` → `Hint`（原生 `title` 至此迁完，只剩 `ConfirmDialog` 的 `title` prop 与 `<iframe title>`）、
`SearchPanel` → `Popover`、插件市场加载态 → `Skeleton`。
另外给一批只有 `aria-label` 的**纯图标按钮**补了 `Hint`（自动化任务的编辑 / 启停 / 删除、协作面板的移除成员、
插件市场的刷新 / 注册表设置、通知卡的关闭）：`aria-label` 只服务读屏，看得见的人需要一条悬停提示。
判断准则与上面一致 —— 提示说的是「点了会做什么」就照常用 `disabled`，只有提示在解释「为什么不能用」时才换 `aria-disabled`。
另有 3 个新弹窗（会话图片灯箱 / MCP JSON / 技能源表单）一开始就建在 shadcn 上：现在共 9 处
`dialog` / `alert-dialog` 使用点、0 处手写模态。
业务按钮改用 `GwButton`（`features/shared/`，首处落地 `SiderFooter`；其余按改到的 feature 顺手迁）。
上游 `Select` / 原生复选框 / `AcpModelSelector` / `SlashCommandMenu` / `SelectionToolbar` 按上节理由保持原样。
新增组件时按本节的约定走，不必专门开迁移轮次 —— 改到某个 feature 时顺手换即可。

## Accessibility

- All text/background contrasts must meet WCAG AA (4.5:1) in both light and dark modes
- `--dim2` is reserved for 10–12px tertiary text (requires extra attention to contrast)
- `color-scheme` is always declared alongside theme roots

## Adding New Tokens

1. Add the token to `tokens.css` under the correct semantic group
2. Add a descriptor entry to `THEME_TOKENS` in `token-contract.ts`
3. Add values for all active palettes (greywork, github, fox, night-blue, night-green, liquid-glass)
4. Ensure `token-contract.test.ts` passes parity validation
