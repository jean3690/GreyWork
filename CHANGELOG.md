# 更新日志

本文件记录 GreyWork 每个版本的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发版流程：新增条目补进对应版本标题下 → 打 `v*` 标签 → `.github/workflows/release.yml` 会自动从本文件
抽取该版本条目作为 Release 说明。**不要手改 Release 正文**，改这里。

## [Unreleased]

## [0.2.0] - 2026-09-21

### 新增

- 预览支持**数据分析**：CSV 与 xlsx 的预览新增「表格 / 分析」模式切换，提供列统计摘要、
  图表（柱状 / 折线 / 饼图，ECharts 懒加载）、分组聚合与筛选排序。统计 / 图表 / 分组基于
  **全部已解析行**（含筛选后的行），数据网格沿用 500 行渲染上限 —— 看得少不等于算得少。
- 预览支持老格式 `.xls` / `.xlt`：由宿主用 calamine 按**内容**嗅探解析（扩展名被改错的
  OOXML 也能正确打开），不再只是「不支持预览」的占位提示。
- 远程助手 · QQ 通道支持「扫码创建机器人」：手机 QQ 扫码确认后，宿主直接把 AppID 与 AppSecret
  写入本机（0600），不必再去 QQ 开放平台抄密钥；手填凭证入口保留作兜底。
- 插件作者文档 `docs/plugin-authoring.md`、市场发布说明 `plugin-market/README.md`，以及可直接
  复制的插件包模板 `plugin-market/templates/`。
- `@greywork/core` 新增 `basename` / `extname` 两个路径工具：`\` 与 `/` 都认，`basename` 先剥
  尾部分隔符再取末段（与同文件的 `normalizePath` 同语义，故 `"reports/"` → `"reports"`），
  `extname` 不含点、不改大小写。
- 标题栏加 GitHub 入口与「检查更新」：GitHub 图标点开本项目仓库；检查更新对比当前版本与
  最新 Release 并展示新版发布说明。Windows / macOS 走 `tauri-plugin-updater` 应用内下载、
  验签（minisign）、安装并重启；Linux deb 无原地升级路径，回落到「前往下载」打开发布页。
- 应用内自动更新的签名与发布：`bundle.createUpdaterArtifacts` 产出带 `.sig` 的更新包与
  `latest.json`，`release.yml` 用仓库 Secrets 里的 minisign 私钥签名（本地 `tauri signer`
  生成，私钥不入库）。这层只保证更新包可信，与 macOS/Windows 的系统级代码签名无关。

### 变更

- 渲染端 7 份手写的 `basename` 副本收口到 `@greywork/core`。`lib/viewer.ts` 与 `lib/attachments.ts`
  保留原导出名转发，`stores/preview.ts`、`SheetViewer.vue`、`attachment-library.ts` 等调用方零改动。
- 扩展名一律从**路径末段**取。此前是对整条路径 `split(".").pop()`，目录名带点时会拿到
  `"v1.2/report"` → `"2/report"` 这类垃圾串，只是靠「命不中就回落 raw / octet-stream」掩盖着；
  现在 `kindOfPath`、`codeLanguageOfPath`、图片预览的 MIME 推断都只在末段上找点。
- 打包元数据补齐：`bundle.category`（deb 的 `.desktop` 从 `Categories=` 空值变为
  `Categories=Development;`，应用菜单里终于能归类）、`shortDescription` / `longDescription`
  （deb 的 `Description` 后面不再跟一行 `(none)`）、以及 `publisher` / `homepage` /
  `copyright` / `license`。各字段究竟落到哪个平台、哪些其实不落地，记在 `docs/packaging.md`。
- Windows 安装包语言设为 `["SimpChinese", "English"]`（Tauri 默认只有英文）。按系统语言自动选，
  zh-CN 命中中文、其余回落英文；不弹语言选择页。
- CI 新增 macOS job（`cargo clippy --locked` + `cargo test --locked` + vitest）。此前
  `#[cfg(target_os = "macos")]` 的用例（APFS 大小写折叠、路径比较）**只被编译、从未执行**：
  desktop 矩阵的 macOS 行只产包不跑测试。
- 插件能力授权改为**按插件粒度**：给 A 授权 `net.fetch` 不再顺带放行 B，插件中心按插件分别授权/
  撤销。旧版全局授权存档（v1）首次启动时自动迁移为按插件授权并写回新存档。
- 界面提示统一走 `Hint` 组件：剩余的原生 `title` 全部迁完，只有 `aria-label` 的纯图标按钮
  （定时任务的编辑 / 启停 / 删除、协作面板的移除成员、插件市场的刷新 / 注册表设置、通知卡的关闭）
  补上悬停提示。提示弹层加了 320px 宽度上限，长文案（完整路径、报错原文）改为按词换行，
  不再被拉成一条超出屏幕的窄条；键盘聚焦也能出提示。
- 引导页 / 对话页的输入卡文案、团队页「编排运行」段、插件市场「能力审计」段的硬编码中文收进 i18n。

### 修复

- deb 包补齐 Debian Policy 要求的三处，同时消除 lintian 对应的 E 级告警：`Section: devel`
  （`bundle.category` 并不填这个字段，它是 `bundle.linux.deb.section`）、`libc6` 依赖
  （Policy 8.6；`deb.depends` 是**追加**到自动算出的 `libwebkit2gtk-4.1-0, libgtk-3-0` 之后，
  不是替换），以及 `/usr/share/doc/grey-work/copyright`（Policy 12.5）。注意
  `bundle.licenseFile` 只被 NSIS 打包器读取，对 deb 无任何作用。
- 停用/卸载插件时回收其桌面悬浮窗（此前窗口会残留并继续渲染已停用的包）。
- 官方插件市场的强制签名校验改为 URL 归一化比较，`.../registry.json?x=1` 之类的变体不再被降级为
  「第三方免签」。
- 宿主 `plugin_window_open` 增加 `window.floating` 声明校验，与安装期校验、前端授权门禁三处一致。
- 卸载插件时清空其能力授权，避免重装同 id 的其它包继承旧授权。
- 补强插件包校验：mode 标题/heading/eyebrow 增加长度上界；`window` 声明必须同时声明
  `window.floating`。
- 清理插件系统死代码（未使用的窗口事件通道、渲染循环错误占位、旧版单计数器页面分支与
  `RenderFrameInput` 类型）。

## [0.1.1] - 2026-09-19

### 修复

- 修复只在 Windows CI 暴露的 6 个单测失败（均为测试对平台的隐性假设，非生产逻辑回归）：
  `process_guard` 的 `%` 断言按平台分叉（Windows 上 `npx` 经 `cmd /C` 中转、`%` 被拒为正确行为）；
  `sandbox` 的 `--ro-bind /usr` 断言限定 Linux；`acp_host` 探测按 PATHEXT 补可执行扩展名、扫描路径分隔符归一；
  `git` 含引号文件名用例限定类 Unix（`"` 在 Windows 文件名非法）；`http` 测试内 server 排空请求 + 优雅关闭，
  消除 Windows 上的 RST(10053)。

## [0.1.0] - 2026-09-17

首个公开版本：Tauri 2 桌面外壳 + Rust 宿主 + Vue 3 渲染层，三平台安装包（deb / NSIS / dmg）。

### 新增

**Agent 运行时**

- 接入 ACP（Agent Client Protocol）外部智能体：内置主流 agent 预设与本机安装探测，会话按对话隔离，
  可向 agent 声明 MCP 服务器。
- 会话配置项（模型 / 思考强度 / 会话模式）由后端探测得出，支持逐项覆盖；团队成员可各持一套配置。
- 本机模型管线：OpenAI 兼容流式供应商，自定义请求头支持 `{{ENV}}` 占位，可调思考强度。
- 权限模型三档（只读 / 工作区 / 完全访问）：宿主拦截越界路径与只读档下的写与执行；「始终允许」
  按工具类别在单次会话内记忆；每次裁决在消息流里留一条只读权限留痕，说明批了什么、谁批的、为什么没问。

**工作区**

- 授权工作区根目录：文件、Git、进程操作全部限定在解析出的根目录内，另配工作区 checkpoint。
- 真实 Git 面板：状态 / diff / 提交，一律经宿主 CLI，边界同上。
- 文件预览：文本（CodeMirror 6 多语言高亮）、Markdown、CSV、图片、PDF（带文本层，可划词复制并送进对话）、
  Office 文档（Univer 渲染 xlsx / docx / pptx）。
- 产物查看器支持多 tab；预览面板支持标签拖拽排序、中键关闭、滚动位置保持与异步骨架屏。
- 网页抓取 `web_fetch`：宿主侧安全抓取 + 前端正文提取，右栏预览可直接「发送到对话」。
- 选区注入：划词与表格选区都能带上下文送进对话。

**可扩展性**

- 基于 Cordis 微内核的插件运行时与声明式插件包（只含受限 JSON，不执行远端 JavaScript），能力需显式授权。
- 插件悬浮窗：透明底、无装饰、置顶、不占任务栏的宠物形态窗口，由声明了 render loop 的插件开启。
- 活动面板汇总会话中产生的产物。
- 市场收在一处：官方插件注册表（带签名 —— GitHub 账号失陷也无法投毒目录）、MCP Registry
  （npm / pypi 包一键登记）与 skills.sh 等技能源。
- Agent 技能放在 `.agents/skills/`，由 `skills-lock.json` 记录哈希锁定。

**对话之外**

- 定时任务：cron 或一次性触发；AI 可在回复里用 `schedule` 围栏提议任务，确认后才真正创建。
- 远程助手七条通道：微信（ClawBot / iLink）、钉钉、飞书、Telegram、QQ、Discord、企业微信 ——
  手机上也能使唤本机助手，凭证只存本机应用数据目录（`0600`），不进设置快照。
- 团队协作会话：多个成员跑同一任务。
- 多模态附件、斜杠命令与通知系统。
- 中英双语界面（zh-CN / en-US）；界面跑在浏览器里时宿主能力自动降级为只读提示。
- 壳层布局模式与左栏偏好持久化，`Ctrl+1~4` 一键切换。

### 修复

- ACP 会话串上下文：新建对话不再接着上一轮的上下文；同时修复 npx 型 agent 冷启动握手超时与超时进程回收。
- Markdown 代码块复制在 WKWebView / WebKitGTK 上静默失效 —— 补 ESLint 门禁挡住整类问题。
- 带图纸的 xlsx 预览失败 —— exceljs 补丁纳入版本控制。
- 修掉 ui-region 用例漏卸载导致的渲染循环定时器泄漏。

### 性能

- 磁盘二进制读取改走 `tauri::ipc::Response`，去掉 base64 的 33% 膨胀。
- pdf.js worker 换预压缩版，安装包 -1 MB。
- 路由视图懒加载 + 文档写入器延迟加载，启动解析量 -80%。
- 会话历史大列表切虚拟窗口；会话持久化弃用 deep watch，文件树改为线性构造。
- 启动打点基线：插件清单与挂载并发，不占关键路径。

### 工程

- 三平台打包矩阵（deb / nsis / dmg）与 `.github/workflows/ci.yml` 的 Rust 侧 fmt → clippy → test 门禁。
- 打 `v*` 标签触发发布工作流，产出三平台安装包并开一个 draft Release。
- Vitest 覆盖率纳入门禁；桌面端 renderer 全链路冒烟 e2e。
- 修掉一批只在 CI 或非 Linux 平台暴露的问题：依赖跑测机器全局 git 身份、glob 模式用原生分隔符导致
  Windows 构建失败、macOS 缺 `macos-private-api` 编译不过、构建脚本里 POSIX 风格的环境变量前缀。

**安装包**：Linux 用 `.deb`（`sudo dpkg -i` 或 `apt install ./`），Windows 用 NSIS 安装器，macOS 用 `.dmg`。
[Unreleased]: https://github.com/jean3690/GreyWork/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jean3690/GreyWork/compare/v0.1.1...v0.2.0

[Unreleased]: https://github.com/jean3690/GreyWork/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/jean3690/GreyWork/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jean3690/GreyWork/releases/tag/v0.1.0
