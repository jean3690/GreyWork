# Codex 风格桌面壳层改造（方案 A · 全量）

> 2026-08-26 · 批准人：用户 · 执行：Claude（本舱六阶段流程）
> 参照：Codex App（2026）「指挥中心」：三栏 + 顶/底状态栏，暗色优先，克制单强调色。

## 目标语义

- 暗色优先：#0D0D0F 系；面板层级 1-2 阶灰度；1px 低对比分割线；8-12px 圆角；功能动画（呼吸点 / 200ms 展开）
- 工作流左→右：侧栏选目标 → 中区下指令 → 右栏看结果
- 并行任务状态一眼可辨（运行=呼吸点 / 待审阅=Badge / 完成=✓）

## 布局规格

- 左侧栏 260px（可收起，<1180 默认收起）：返回/前进、新对话、搜索、Plugins/Automations/Skills 入口、Projects 线程分组树、底部 Chats + 头像
- 顶栏 56px：项目名+会话 | Local/Worktree/Cloud 胶囊 | 模型选择 | 动作组（IDE/新建自动化/设置）| 右栏开合
- 主舞台：对话流（轻量 Markdown：代码块路径标签+行号+复制）、空态标题「有什么可以帮你？」、Composer（+、盾牌权限三档、计划模式、发送、Cmd+Enter）
- 右栏 420px：标签序 Diff/预览/终端/交付物/Review/Sources；Diff 底部动作条（Commit 真实 / Push·PR 禁用+tooltip）
- 底栏 24px：git 分支 | Token 用量（无源 →「—」）| 连接态（ACP 就绪 / Web 预览）

## 文件清单

| #   | 文件                            | 动作                                                                                       |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | theme/tokens.css                | 暗色翻转 + 布局变量（--gw-sidebar-w/--gw-side-w/--gw-statusbar-h；去 rail）                |
| 2   | theme/shadcn.css                | 暗色同步                                                                                   |
| 3   | theme/base.css                  | shell 布局重写；rail 样式删除；sidebar/statusbar/code-block 新增；硬编码浅色清扫；断点调整 |
| 4   | plugins/types.ts                | UiRegionId += "shellSidebar"                                                               |
| 5   | plugins/registry.ts             | projectRail×3 → shellSidebar×3；activityPanel 排序 Diff/预览/终端/交付物/Review/Sources    |
| 6   | plugins/loader.test.ts          | 区域计数同步                                                                               |
| 7   | stores/settings.ts              | runMode + 权限档重标签（只读/允许编辑/完全执行）                                           |
| 8   | components/ShellSidebar.vue     | 新，容器渲染 shellSidebar 槽位 + 搜索                                                      |
| 9   | components/sidebar/\*.vue       | SidebarEntries/SidebarProjects/SidebarUser 三段                                            |
| 10  | components/TopBar.vue           | 重排：项目/会话/模式胶囊/模型/动作；搜索与 PermissionSwitch 迁出                           |
| 11  | components/StatusBar.vue        | 新 24px                                                                                    |
| 12  | components/MarkdownText.vue     | 新轻量渲染（围栏代码块/行内 code/粗体/链接）                                               |
| 13  | views/ChatView.vue              | 去模型选择；composer 盾牌档+计划开关+Cmd+Enter；Markdown 接入                              |
| 14  | components/panels/DiffsPane.vue | 分组 diff + 动作条（commit 真实/PR 禁用）                                                  |
| 15  | AppShell.vue                    | 新壳层结构 + 状态栏                                                                        |
| 16  | 删除                            | ProjectRail.vue、rail/\*、PermissionSwitch.vue（无引用后）                                 |
| 17  | docs/ui-design.md               | 布局/配色章节同步                                                                          |

## 诚实边界（不造假）

- Worktree/Cloud：仅 UI 态（settings.runMode = "local" 默认，宿主语义缺失，UI 注明）
- Push/Create PR：禁用 + tooltip「需远程后端」
- 语音输入：不实现（无后端，不做假按钮）
- Token 用量：状态栏显示「—」
- Inter：候选栈 `"Inter", system-ui, …`，不强绑

## 验证

- vue-tsc（workbench + desktop）
- vitest（loader.test 计数更新后全绿 + 覆盖门禁）
- eslint / prettier
- 浏览器 smoke：暗色渲染、侧栏线程切换、composer 发送、Markdown 代码块、状态栏、右栏 Tab、1180/640 断点
