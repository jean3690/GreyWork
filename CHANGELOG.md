# 更新日志

本文件记录 GreyWork 每个版本的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发版流程：新增条目补进对应版本标题下 → 打 `v*` 标签 → `.github/workflows/release.yml` 会自动从本文件
抽取该版本条目作为 Release 说明。**不要手改 Release 正文**，改这里。

## [0.6.0] - 2026-09-30

### 新增

- **内嵌浏览器**：预览面板的抓取对话框加「正文 / 浏览器」双模式，浏览器模式把 URL 交给宿主里的
  原生子 webview —— 可登录、可交互、能访问本地 dev server，会话落在专用的 `browser-profile`
  目录（与主 webview 存储隔离）。子 webview 渲染的是**不可信远端内容**，故按不可信方隔离：
  不注册任何 capability、远端 origin 的 IPC 被 Tauri 按 origin 直接拒，`on_navigation` 只放行
  http/https/about/data/blob，新窗口 / 下载 / 权限请求一律拒。全应用只有 `gw-browser` 一个
  webview（跟随当前浏览器标签，换 URL 走导航而非重建，会话 / 滚动得以保留）；原生层永远压在
  主窗口 DOM 之上，检测到弹层就藏起来，避免弹层 / 右键菜单被整个盖住。命令表 145 → 154。
  Linux 上 Tauri 的 `Window::add_child` 会把子 webview 塞进主窗口默认 GtkBox、槽位坐标被 GTK
  布局吃掉，故 Linux 走 wry 直建进 `gtk::Fixed`；Windows / macOS 走 Tauri `add_child`
  （需 cargo `unstable` feature）。
- **3D 模型预览**（three.js）：glb / gltf 注册成新的 `3d` viewer，走媒体通道并带 `bytes` 偏好
  （GLTFLoader 要整份字节），额度 64MB。`.gltf` 引用外部 .bin / 贴图时给「导出成自包含 .glb」
  的出路提示而不是留一个空场景；切 tab / 卸载时逐项 dispose 几何 / 材质 / 贴图，避免显存泄漏。
- **GIS 矢量预览**（MapLibre GL）：geojson / shp 注册成新的 `gis` viewer，用空 style —— 不挂底图
  就没有任何外部请求，CSP 一行都不用改；要素按 `geometry-type` 分成点 / 线 / 面三层（一个集合里
  混着三种几何是常态），视野按数据包围盒自动 fit。shp 顺带读同目录 .prj / .dbf，读不到就降级为
  只画几何。刻意不收 `.json`（绝大多数是普通数据文件，归到 gis 会让它们失去代码视图）。
- **视频预览改走流式通道**：新增自定义 URI scheme `gwmedia://`，按 HTTP Range 以 1MB 分片供文件
  （支持后缀 range，MP4 的 moov atom 在文件尾时必需），授权复用
  `WorkspaceFsAccess::resolve_existing`、不另建白名单。此前的「整份读进内存再塞 blob URL」对真实
  视频不成立 —— IPC 传输加同步 `new Blob` 拷贝会冻住渲染进程、WebKit 还要缓冲完整个 blob 才
  起播（seek 基本失效）。宿主侧新增 `fs_read_media`（128MB 硬上限，超限报错而非截断，半个文件会
  以「格式损坏」出现、比大小报错难查）；`fs_read_binary` 的 20MB 契约不动。
- **内置技能机制**：随宿主二进制发布、不联网、不依赖用户配技能源的技能 —— 内容与宿主版本一起走，
  不会因为市场条目改名 / 下架而失效。`include_str!` 把内容嵌进二进制，`skills_bundled_list` 出
  目录、`skills_install_bundled` 按 id 写盘，写入复用市场安装的净化路径（抽成共用的
  `write_skill_snapshot`），不存在第二份会漂移的净化逻辑。首份内置技能 `ffmpeg-media`：ffprobe
  探测 → 截取 / 转码 / 抽帧 / 拼接 / 压缩 / 提音轨，产物落工作区可被预览层直接打开。插件市场
  「技能」区与 设置 → 技能 都新增「内置技能」区（未装显示安装、已装显示重新安装，二次确认后落盘）。
- **ACP 权限卡片全局化**：活跃态权限卡片原先只挂在 `ConversationView` 的输入区，而后台任务 / 远程
  助手 / 定时任务触发的权限请求、或用户停在引导页 / 团队 / 定时任务页时，界面上没有裁决入口 ——
  请求只能干等到 120s 超时被自动拒绝。新增 `PermissionPromptHost`，挂在 `Shell` 里、在读全局
  store 的 `pendingPermission`，任意路由都能看到并裁决。
- **品牌标识改为圆角方块**：源标识的白底满画布路径加一个 35% 圆角矩形裁切，favicon / 桌面图标 /
  应用内 `<img>` 都跟着圆、不再依赖使用方自己加 border-radius（各调用点的圆角值此前并不统一）；
  并按新标识重新生成全部桌面图标（icns / ico / png / Windows Store 全套）。

### 变更

- **引导页输入框收紧**：rows 3 → 2、`min-h` 88 → 60px（默认三行偏高，输入区下方留白明显）；
  会话搜索框 `h-7` → `h-6`（与同排其它小控件对齐）。两处都只改高度。
- **发布产物开启 LTO**：`[profile.release]` 加 `lto = true` / `opt-level = 3` / `panic = "abort"` /
  `strip = true`，换更小更快的发布产物（本仓没有任何 `catch_unwind` 依赖 `panic = "abort"`）。
  `[profile.dev]` 打开 `incremental = false` —— `target/debug/incremental` 实测占 33G / 512 个
  目录，而 cargo 从不回收旧的增量会话目录；代价是改 `greywork_host` 要全量重编。顺带修两处笔误：
  `opt-level = "3"`（字符串非法，cargo 拒绝解析整个 manifest）→ `3`、`trip` → `strip`。

### 修复

- **从托盘退出后下次启动窗口不出现**：`tauri.conf.json` 的主窗口是 `visible: false`（靠
  window-state 插件 `restore_state()` 里的 `show()` 显示），而插件默认的 `StateFlags::all()`
  含 VISIBLE —— 「关闭到托盘」退出时窗口是隐藏的，插件把 `visible: false` 写盘，下次启动
  `should_show = false`、永不 `show()`。改为排除 VISIBLE，并在 `setup` 末尾无条件 `show_main()`
  兜底（可见性由应用自己管）。
- **反复双击图标起多个进程**：窗口不出现时用户以为没启动、反复双击，每个进程各起一份托盘 / ACP
  宿主。引入 `tauri-plugin-single-instance`（插件要求**第一个**注册），第二次启动不再起进程，
  回调把已有窗口 show + unminimize + focus 叫回来。新增 drift 守卫
  `window_state_flags_exclude_visible` 钉住「可见性由应用自己管」，有人改回默认就会重新引入 bug。
- **「关闭即退出」点 × 无反应**：Tauri 只要发现渲染端注册了 `tauri://close-requested` 监听就
  无条件 `prevent_close()`，把「真的关掉」整个甩给 JS 包装层；而包装层在不 `preventDefault()`
  时的默认动作 `plugin:window|destroy` 渲染端并未被授权，于是窗口永不销毁。新增宿主命令
  `close_main_window` 把「隐藏还是真关」的判据收回宿主（仍是 `TrayState::should_hide_on_close()`
  单点真相），渲染端一律 `preventDefault()` 后请宿主收口；刻意**不**补
  `core:window:allow-destroy` —— 那会让「关闭到托盘」退化成「关闭即退出」。

### 工程

- **架构文档与注释更新**：补「3D 与 GIS：容器先于内容」与「媒体播放：流式而非缓冲」两节；更正
  viewer 分派、技能安装路径等过期描述（删掉不存在的 `skills-lock.json`、`host_exec.rs` 并非进程
  执行）；服务端 CSP 的 `worker-src` 注释补上 GIS 预览（MapLibre 也会建 blob Worker）。

## [0.5.0] - 2026-09-29

### 新增

- **新增 Liquid Glass 配色**：第六套 palette。面板表面改用半透明 `rgba` 填充，并叠一层背板模糊
  （`backdrop-filter: blur + saturate`）采样下层表面，读作磨砂玻璃。模糊只在
  `[data-palette="liquid-glass"]` 下挂到承载表面色的工具类上，其余 palette 的表面照旧不透明；
  画布底 `--ink` 刻意保持不透明，为模糊提供可采样的底色。`--glass-blur` / `--glass-saturate`
  是效果旋钮，与 `--gw-*` 同口径，不进主题令牌契约。
- **外观新增「无圆角 / 小圆角 / 大圆角」档位**：一个旋钮（`--gw-radius-scale`）管住全界面圆角，
  默认档即改造前的原值，行为逐像素不变。范围是**真·全局**而不只是 shadcn —— 改造前全仓 760 处
  `rounded-*` 里只有约 49 处走 shadcn 的 `--radius` 链，其余约 580 处是写死的 px。故一次性 codemod
  把 109 个 `.vue` 里的 577 处写死 px 圆角（含 `rounded-tr-[8px]` 这类方位形式）改写成
  `calc(Npx * var(--gw-radius-scale))`；shadcn 的 `--radius` 与派生的 `--radius-md/sm`、
  `input-group` 的 `calc(var(--radius) - 5px)` 一并接到同一变量，后者包一层 `max(0px, …)`——
  否则「无圆角」档会算出 CSS 非法的负半径、整条声明被丢弃。`rounded-full` / `rounded-none`
  是语义性的，不跟随旋钮。
- **圆角防回归守卫**（`scripts/radius-guard.mjs`，接进 `pnpm lint`）：写死的 `rounded-[8px]` 不报错
  也不红灯，它只是那一个控件悄悄不跟随设置 —— 这类静默失效直接拦在 lint 里，报错信息给出改法。
  于是 CI 的 lint job 与 `pre-push` 都覆盖，不新增钩子。
- **跨语言 ACP 门禁**：新增渲染端 `@agentclientprotocol/sdk` × 真 Rust 宿主的端到端链路
  （`createAcpClient` → host-ipc → 真 `greywork-server` → `AcpHost` → 假 agent），断言
  initialize → session/new → prompt → agent_message_chunk → prompt-done 全链路，外加三条反向守卫
  （transport 不得静默回落到 WebSocket 分支、白名单外程序被真实 `process_guard` 拒绝、流式 chunk
  必须早于 prompt-done）。此前两侧是两套独立实现、两条独立版本线，「各自编译过、单测过」并不代表
  接得上。跑在独立的 `test:integration`（刻意不进 `pnpm -r test` —— 那个 job 没有编译产物，也不该
  为它多编一次服务端），CI 另开 `acp-e2e` job 并复用既有的 Rust 缓存键（本仓缓存额度已顶到上限，
  按 job 名另起一个键会把 master 那份挤出去）。
- **宿主补 AcpHost 命令面直测**：`acp_start` / `acp_new_session` / `acp_send` / `acp_stop` 此前
  零覆盖 —— 原有 6 个 ACP 集成测试全部绕开 `AcpHost`、直接驱动 client 去连 agent，而前端唯一会走的
  正是这几个命令。

### 变更

- **依赖跨大版本批量刷新**（分五组，逐组独立验证）：
  - 前端：pinia 3→4、vue-router 4→5、@vueuse/core 14→15（仓库侧零代码改动，逐个核对过用法面）；
    eslint 9→10、@eslint/js 9→10、globals 16→17、lint-staged 16→17；vite 6→8、
    @vitejs/plugin-vue 5→6、vue-tsc 2→3；vitest 3→5；`lucide-vue-next` → `@lucide/vue`。
  - Rust：tauri 2.11.5 → 2.12.0（与前端 `@tauri-apps/api` 配对）、agent-client-protocol
    2.0.0 → 2.2.0（schema 1.5.0 → 1.9.1，补齐 ACP 两侧版本线）。
  - **vite 8 换掉了打包器**：Rolldown 取代 rollup/esbuild，构建 37s → 3.4s。它把默认
    `build.target` 从 es2020 档改成 `baseline-widely-available`（Safari 16.4），不写死就会
    **静默**把渲染端语法底线从 Safari 14 抬上去，故显式写回升级前那一档。
  - `lucide-vue-next` → `@lucide/vue` 是**换包名**而不是升版本：旧包上游已标 deprecated 且停在
    1.0.0，替代品是同一项目还在正常发版的新包名。22 个文件的 import 随之调整，
    `scripts/shadcn-sync.mjs` 里「把 `@lucide/vue` 改写成 `lucide-vue-next`」那条规则的前提反转，
    一并删除 —— 留着它只会把新生成的组件改回被弃用的包名。
  - 根 `engines.node` `>=20` → `>=22.22.1`（本批最紧的约束来自 lint-staged 17；CI 用 Node 24、
    本机 24.18，这条声明一直落后于事实）。
  - `@univerjs/*` 12 个包从 `^0.25.1` 改成精确 pin `0.25.1`：patch 键带精确版本而声明写 range，
    任何不做包名限定的依赖解析都会把 univer 抬到 0.25.2、patch 键随即失配，pnpm 以
    `ERR_PNPM_UNUSED_PATCH` 中止整条命令（已用裸 `pnpm update -r` 复现）。
  - eslint 10 的 recommended 集新增两条规则，逼出 3 处真实修复（包装超时错误时补回 `cause`、
    去掉两处 `let x: T | null = null` 的死初始化）。
- **mermaid 12 暂不升级**：评估时用真渲染冒烟发现 12.0.0 的新布局管线对图里的非 ASCII 标签
  （中文必中）执行 `btoa(JSON.stringify(points))` 会抛 `InvalidCharacterError`，整图渲染失败；
  `btoa` 是 Latin1-only 的，happy-dom 与真浏览器行为一致，不是测试环境的假象。原因与「等上游修掉
  后还需显式钉回 `layout: "dagre"` + `look: "classic"`」一并写进了门面的注释。
- **忽略清单与 `.dockerignore` 对齐**：`prettier --check .` / `eslint .` 此前每次都要把
  `.pnpm-store` 整棵走一遍 —— 那是历史遗留的仓库内 pnpm store（1GB / 4.7 万个哈希名文件），
  而当前 pnpm 用的是全局 store，仓库里没有任何配置引用它，等同孤儿。

### 修复

- **`pnpm -r test` 全过却以退出码 1 收场**：`Vitest caught 10 unhandled errors`，全部是
  `Cannot read properties of null (reading 'insertBefore')`。根因是两个测试文件用
  `document.body.innerHTML = ""` 清扫，把 DOM 整个抽走而**挂上去的组件树还活着** —— 悬着的延时
  回调（tooltip 的 300ms、右键菜单的关闭定时器）随后落地，组件照常 patch，容器已经是 null；用例
  本身仍是绿的，错误以 unhandled rejection 的形式把整轮测试染红。改用
  `enableAutoUnmount(afterEach)` 由 @vue/test-utils 真正卸载组件树（先清 body 再卸载反而会在
  unmount 里抛 `nextSibling` null，这个坑实际踩过）。
- **token-contract 的一条既有红**：`--glass-*` 是效果旋钮，但契约测试的豁免集只登记了 `--gw-*`，
  于是「`tokens.css` 里每个非结构变量都必须在契约内」那条反向断言失败。
- **vue-tsc 3 报出的 4 处 TS6133 里有一处是真死代码**：composer 的 `attachEl` 全仓没有任何读取
  （拖放命中判定走 `elementFromPoint(...).closest(...)`），连同 3 个调用方的声明与模板 ref 一并
  删除；另一处 `useUniverHost` 的 `host` 只是检查器看不到字符串绑定，为迎合检查器去窄化 composable
  的契约不值得，改成更该有的设计——元素 ref 归组件自己所有、传进 composable。
- **适配 vitest 5**：对齐 `coverage-v8`、修 `vi.fn` / `localStorage` 的用法、按 AST 精确重映射后
  重校覆盖率门槛；另修 mock Shell 懒加载子组件在 Windows 下环境拆除后动态导入报错。

### 工程

- **eslint 开 `--cache`**：类型感知 lint 那约 46s 是 12 个包各建一套 TS program 的开销、不是读盘，
  缓存落在 `node_modules/.cache/eslint/`（刻意不用默认的仓库根 `.eslintcache`，省得再往
  `.gitignore` 加一条）。本机冷跑 46.46s → 热跑 2.09s；CI 是全新 checkout，照旧每次冷跑全量，
  门禁不打折。`lint:fix` 保持不缓存。
- **`.ui-shots` 移出版本库**：UI 渲染自测的截图此前被误提交进 git，与 `.playwright*` 同性质
  （本地验证留痕；PNG 不适合 git delta，每张新截图都永久撑大所有 clone）。4 张历史截图删除，
  目录补进 `.gitignore` / `.prettierignore` / eslint 三份忽略清单。
- **新增磁盘回收脚本 `scripts/disks-reclaim.mjs`**（`pnpm disks` / `pnpm disks:reclaim`）：
  cargo 增量编译目录按 mtime 剪枝、docker 悬空镜像与构建缓存、`pnpm store prune` 三块，**默认
  dry-run**，要真删必须显式 `--apply`（docker 的卷另需 `--volumes`——匿名卷里可能有别的项目的
  数据，docker 判断不了）。起因是 dev 产物能长到几十 GB（实测 `target/debug` 66GB，其中增量目录
  33GB）而 cargo / docker / pnpm 都不会自动回收自己的陈旧缓存。
- **`.husky/pre-push` 在跑 clippy / test 前关掉增量编译**（`CARGO_INCREMENTAL=0`）：clippy 与 test
  的指纹互不相同，各自会建一整套增量会话目录，而 cargo 从不回收旧的，一次推送就能造出几百个
  （实测 515 个目录里，09-24 一天就 284 个）。只在钩子里关、日常开发照旧开着 —— cargo 只给
  workspace 成员与 path 依赖开增量，所以关掉不会让 `deps/` 里那 29.3G 失效，代价只是几个本仓
  crate 在推送前编一次。

## [0.4.0] - 2026-09-28

### 新增

- **web 端新增登出入口**：侧栏底部的占位「用户」行换成真实账户行——显示身份、点击直达助手页，
  服务端态再给一个登出按钮（桌面态无此概念，不渲染）。登出走 `POST /api/logout` 且二次确认；
  无论请求成败（含 401 与网络异常）本端都会把登录门重新关上——「登出的语义是本端不再持有会话」，
  不把「服务器没收到」当成「还登着」。
- **服务端命令目录与逐命令能力发现**：`GET /api/commands` 在既有元数据上新增 `available` 字段
  （「本宿主禁用」与 `desktopOnly` 的「任何宿主都没有」刻意分开）；渲染端新增命令能力表 store
  首用即拉、会话内缓存。能力值三态：`true` 放行、`false` 明确禁用、`null` 未知——读路径
  fail-open（未知不禁），服务端写路径 fail-closed（未知不写），语义由调用方各取所需。
- **云端 Office 预览**：新增「第三方服务」设置，可配置多家云端 Office（WPS / 腾讯文档等）的文档
  预览：选中文件由**宿主**按声明式配方上传到厂商接口，取回可内嵌的文档地址后在预览区用 iframe
  打开 —— 能看本地解析不了的大文档，且厂商凭证只经环境变量注入宿主、不进渲染端。宿主把真实的
  可内嵌白名单（`frame-src` 放行的 origin）回给渲染端，渲染端在**上传前**先判地址是否可内嵌、
  **取回后再判一次**，不可内嵌时直接回落到本地预览并点明被拦的 origin，避免「白屏且控制台之外
  无提示」。桌面壳的 CSP 写死在打包配置里，所以自定义厂商只在服务端态生效（服务端 CSP 由
  `GREYWORK_FRAME_ORIGINS` 启动时拼），设置页对此如实标注。
- **定时任务可交由服务端主执行**：新增 `GREYWORK_AUTOMATION_HOST_PRIMARY=1`，置位后宿主成为定时
  任务的**主执行者** —— 到点即由本进程执行，不再需要一台一直开着的电脑。默认仍与桌面端一致
  （宿主只在渲染端缺席 2 分钟后兜底认领），升级不会让既有部署突然自己跑任务；两种角色共用同一套
  行级原子认领，双执行防护不变。注意无人值守的模型凭证取自服务端进程的环境变量，容器里需在
  compose 注入，否则任务会以「无可用模型配置」失败。
- **服务端可容器化部署（web 端）**：新增多阶段 `Dockerfile`（Node 构建 SPA + Rust 编译
  `greywork-server`，最小 `debian-slim` 运行时）、`docker-compose.yml`、`.env.example` 与部署文档
  （docs/packaging.md）。二进制内置 `healthcheck` 子命令供容器 HEALTHCHECK（镜像不带 curl / wget）；
  监听非环回地址却未开 `secure_cookie` 时启动告警——提示前置 TLS 反代，避免登录凭据明文过网。
  compose 默认禁提权（`no-new-privileges`）；需要 agent 沙盒的 fs / full 两档时叠加
  `docker-compose.sandbox.yml`（代价与实测能力矩阵写在文件里）。另有独立的 Docker CI 只做
  「镜像能不能构建、起来后探针与 UI 是否正常」的冒烟。
- **服务端补齐安全响应头**：headless 服务端对每个响应加 `Content-Security-Policy`（对齐桌面 Tauri
  CSP，另放行入站视频 / 语音缩略图的 `media-src blob:`）、`X-Frame-Options: DENY`、
  `Referrer-Policy: no-referrer`、`Permissions-Policy`（相机 / 麦克风 / 定位等一律拒绝，唯独不碰
  `clipboard-*`——界面靠 `navigator.clipboard` 做复制按钮），并在开启 `secure_cookie`（即「已在 TLS
  反代之后」的信号）时下发 `Strict-Transport-Security`（此前只有 `nosniff` 与 `no-store`）——
  自托管 Web 端不再缺 CSP 与防点击劫持。策略与真实托管产物的一致性由 e2e 把关：真服务端托管
  构建产物，走登录门并依次打开 markdown / HTML / PDF / xlsx 四类预览，断言零 CSP 违规。
- **服务端态断线重连自动对齐状态**：web 端事件走一条 `/api/events` WebSocket 且不重放；断线重连时宿主
  先发 `host://hello`，远程助手 store 据此重拉各通道状态与媒体能力矩阵（跳过首帧连接），修掉重连后
  通道在线状态陈旧的问题（桌面端走 Tauri IPC，不受影响）。
- **企业微信入站语音接入**：企业微信「API 模式 · 长连接」的语音消息只下发转写文本
  （`voice.content`，没有可下载的原始音频），此前被当作不支持类型丢弃 —— 现按转写文本转达，
  远程助手可直接应答语音内容。其余通道的语音是可下载音频、走既有媒体收发；企业微信是唯一
  以转写文本承载语音的通道，故不进媒体能力矩阵。
- **微信远程助手支持图片与文件收发**：手机发来的图片 / 文件由宿主下载并用 AES-128-ECB 解密后
  落进收件目录，渲染端取走落进会话附件库，可直接喂给本机模型或 ACP 后端；反向也能把桌面端
  选中的文件、以及本回合产出的交付物加密上传后发回手机（单文件上限 20MB）。远程回合会告知
  模型「对方不在本机」，因此被要求发文件时不再答「文件已在本机」——它用回复末尾的 sendfile
  围栏点名要发的路径即可；可发范围限工作区与用户已授权的目录。
- **远程助手文件传送铺开到全部 7 条通道**：图片 / 文件收发从仅微信扩展到 Telegram / Discord /
  飞书 / QQ / 企业微信 / 钉钉，按各协议真实能力落地并在界面上如实标注 —— 前四条与 QQ 双向收发
  （QQ 出站走 4 步分片上传），企业微信收图片 / 文件但只能发图片（被动回复没有文件出口），
  钉钉只能收图片（sessionWebhook 没有媒体通道）。入站媒体由宿主下载后落进各通道自己的收件
  目录（企业微信还要按 `aeskey` 做 AES-256-CBC 解密），渲染端取走即删、交会话附件库；出站走
  统一的 `channel_send_media`，授权面与 20MB 上限在宿主侧一处把关。各通道协议端点手写，
  未引入第三方 Rust SDK（微信仍用 `wechatbot`）。
- **远程连接归入专属工作区**：所有通道的新联系人会话统一进入「远程助手」工作区，默认使用 `~/.greyWork/remote`（可自定义）；退出登录或清除凭证后重连会自动新开会话，普通断线重连保留上下文。
- **对话附件新增通用文件类型**：附件不再只认图片与文本，PDF / 压缩包 / Office 文档等一律收下
  并落盘（浏览器态无文件系统仍不收）。模型侧不内联内容，只递一条 `[文件：名字（本地路径：…）]`
  引用 —— 本机 ACP agent 可按路径直接读，纯 LLM 至少知道文件存在。
- **Office 文件可编辑并保存**：xlsx / docx / pptx 预览从只读改为可编辑，改动经 Ctrl+S 或工具栏
  保存按钮写回来源（磁盘或 VFS），标签页脏点与关闭前确认统一兜住未保存改动。
  - xlsx：延用 Univer 表格编辑，保存时 Univer 快照经 `univerWorkbookToXlsx` 反向序列化回 xlsx；
    **含图表 / 图片的表拒绝保存**（读入时图元已被剥离、exceljs 写入器也不写回，存下去会静默丢失），
    提示改用「用系统应用打开」。
  - docx / pptx：正文文本 run 就地可编辑，保存只对原 zip 里命中的 `w:t` / `a:t` 做文本补丁、
    其余字节原样保留（不改结构 / 样式 / 母版 / 媒体）；仅支持改文本，不支持增删段落或改版式。
- **文本 / 代码预览可就地编辑并保存**：`code` 与 `raw` 两类预览不再只读 —— CodeMirror 去掉
  `readOnly`、装上历史与键位表，改动经 Ctrl+S 或工具栏保存按钮写回磁盘 / VFS。两条前提由宿主
  探测决定：判为二进制的给占位（不去读内容），非 UTF-8 的保持只读并说明原因。
  - **编码与行尾保真**：读盘时 BOM 已被剥掉、CodeMirror 的 doc 一律用 `\n`，所以保存前按探测
    结果补回 BOM 与 `\r\n` —— 否则在 Windows 工作区里改一行会变成整文件行尾变更。
- **图片预览加缩放 / 平移 / 旋转**：工具栏加放大 / 缩小 / 适应 / 1:1 / 左转 / 右转，滚轮以指针
  为不动点缩放，放大后可拖拽平移；换图（revision 变化）时视图归位。变换全走 CSS transform，
  不重采样，所以放大是模糊的（换取不动 `<img>` 的布局盒与 `src`）。
- **PDF 预览加跳页与缩放**：工具栏加页码输入 / 上一页 / 下一页与缩放档位（1 倍 = 适应宽度），
  跳页时先补渲染到目标页。缩放落在渲染阶段而不是套 CSS transform —— 只有 canvas 的 CSS 尺寸
  跟着变，滚动区高度才是真实高度。
- **错误态与二进制占位给出「用系统应用打开」出口**：文本、图片、PDF、文档四个 viewer 的失败态
  统一挂一个兜底按钮（仅当 tab 有磁盘孪生路径时出现），大文件超限不再只是干瞪一行报错。
- **文件树支持新建 / 重命名 / 删除 / 复制 / 剪切粘贴**：宿主补了 5 个命令
  （`fs_create_file` / `fs_create_dir` / `fs_rename_path` / `fs_copy_path` / `fs_delete_path`），
  右键菜单按目标给「新建文件 / 新建文件夹 / 重命名 / 复制 / 剪切 / 粘贴 / 删除」。
  - 重命名**就地编辑**（整行换成输入框：`<input>` 不能嵌在 `<button>` 里，所以重命名期间
    该行整体让位，`data-ctx` 上移到行外层，改名时右键仍命中同一行）；新建走弹窗，删除走确认框。
  - 操作后只**重列受影响的目录**，仍然存在的节点对象原样接回去 —— 不能图省事调 `refresh()`，
    它会清空展开态，把用户刚整理好的树整棵折回去。
  - 已打开的预览 tab 会跟着改路径（改名 / 移动按前缀搬），删除则关掉受影响的 tab，
    否则编辑器下次保存会写回一个不存在的旧路径。
  - 边界：只作用于**授权根内**（单独授权的散文件不参与，避免「能删不能改名」的割裂）；
    `from` 一律取**条目自身**而不是符号链接目标（删软链不该删掉目标文件）；
    复制目录时跳过目录内的符号链接（不把根外内容搬进来）；跨分区移动**降级为「复制 + 删除」**
    （顺序是先复制成功再删源，中途失败最多留个多余副本，不会出现「源已删、目标残缺」；
    条目内含符号链接时拒绝降级，否则那些链接会被连同源一起抹掉）；目标已存在一律拒绝
    （Unix 的 `rename` 会静默覆盖）。
- **变更面板支持逐文件暂存与选择性提交**：列表拆成「已暂存 / 未暂存」两区（同一文件两侧都有
  改动时两个分区各出现一次），每行带暂存 / 取消暂存按钮，头部有全部暂存 / 全部取消，
  提交框主按钮**只提交已暂存**，另留一个「全部变更」保留旧的 `add -A` 行为。
  - 宿主侧 `git_changes` 改为**分侧上报**（`index` / `worktree` 各自的状态与行数，不再把两侧相加），
    `git_diff` 加 `staged` 参数并按侧取 diff（不再把两段拼在一起），新增 `git_stage` / `git_unstage`。
  - 取消暂存处理两个坑：**没有提交的仓库**没有 HEAD 可 reset，回落 `git rm --cached`；
    **重命名要成对处理**（新路径 + 旧路径一起 reset，否则索引里留一条删不掉的幽灵变更）。
  - 顺带修 `--numstat` 对重命名的解析：git 的花括号压缩形态（`dir/{old => new}.txt`）
    会被按 `=>` 切错，现在取到的是正确的新路径。
  - 面板文案全部转 i18n（此前整块是硬编码中文）。
- **变更面板新增「历史」页**：只读的提交列表（短 hash、主题、作者、时间、引用装饰），
  点一条就地展开该次提交的 diff；取满一页时给「加载更早的提交」按 `skip` 翻页。
  - 宿主新增 `git_log` / `git_show`：log 用 US/RS 控制字符当字段 / 记录分隔符（主题里含
    分隔符也不会错位），limit 默认 50、上限 200；show 用 `--format=` 压掉提交头，只回 diff 正文。
  - 没有提交的仓库返回空列表而不是报错；历史**惰性加载**（第一次切到该页才拉），
    提交 / 暂存后若历史已打开会自动重拉。
  - diff 的行级渲染抽成 `GitDiffBody.vue`，与变更页共用（两处各写一遍迟早会在行数上限
    与标记符上走岔）。
- **文件树支持键盘导航与拖拽移动**：焦点在某一行上时，方向键在行间移动焦点、右键展开 /
  进入子项、左键收起 / 回到父行、Home / End 跳首尾、F2 就地改名、Delete 走确认后删除、
  Ctrl+C / X / V 走应用内剪贴板（Enter / Space 不接管，交给 button 原生 click）。
  拖拽可把条目移到目录行（拖到文件行 = 移到它所在的目录）或空白区（= 移到根目录），
  拖进自己的子树、落到当前所在目录都会被拒绝，拖拽期间落点行高亮。

### 变更

- **服务端态的界面开始说实话**：更新检查、系统信息的门从「是不是 Tauri」换成「宿主命令可不可用」，
  浏览器预览态专属的早退不再误伤服务端；关于卡显示运行形态与服务端版本；沙盒与权限档位卡改按
  「钉住」判定——服务端把这两样钉在启动配置里时按钮禁用并说明「以服务端为准」，未钉住时照常可改
  （临时只读开关与档位按钮一并禁）。`sys_info` 如实回传钉住事实与宿主版本，桌面壳传自身状态，
  服务端取自启动配置、与沙盒覆盖逻辑同源。
- **agent 目录在服务端态只读**：`db_agents_sync` 被服务端禁用时，设置页与对话底栏的写入面都收起来
  （新增 / 编辑 / 启停不给点），并就地说明「改动只落在浏览器本地、会与服务端数据库悄悄分叉」；
  对话底栏选择未启用的后端也不再代用户顺手启用，让「尚未启用」错误就地可见。判据与写路径门同源
  （命令能力表），未来服务端放开该命令时前端零改动自动恢复可写；图标覆盖层不走这条命令，保持可改。
- **预览查看器与右侧面板外壳的文案接入 i18n**：DiffViewer / DocViewer / HtmlViewer /
  LegacyOfficeViewer / MarkdownViewer / SheetViewer / SlideViewer / PdfViewer 的加载、
  读取失败、解析失败、空态与工具条摘要，以及 PreviewSider 的区段标签、工具栏 / 标签的
  aria-label 与空态文案此前都是硬编码中文，现全部走 locales（en 同步补齐）。
  带变量的整句（「共 N 页」「仅显示前 N 行，共 M 行」）做成单键 + 参数，不把半句话拼在模板里。
- **微信通道的协议实现改为官方 Rust SDK（`wechatbot`）**：扫码登录（含配对码 / IDC 重定向 /
  已绑定复用）、长轮询收信、文本与媒体收发、CDN 上传下载、AES-128-ECB 加解密此前都是宿主
  手抄协议，现整条交给该 SDK；宿主只保留它管不到的那层 —— 状态机、凭证落盘（0600）、入站
  媒体落进收件目录等渲染端取走、Tauri 命令与事件、发送者策略。手写协议层连同 `aes` /
  `ecb` / `md-5` 三个依赖一并删除，换来的是：媒体上传按协议用 `upload_param` 拼地址、
  上传失败自动重试、超长文本自动分段、会话过期自动重登。
  随之的边界（SDK 不暴露 / 不提供，如实记下）：
  - 扫码界面不再有「已扫码待确认」中间态（SDK 只在拿到二维码时回调），
    `wechat_login_poll` 的产出只剩 wait / confirmed / expired；
  - 「正在输入」只能发不能撤（SDK 固定 status=1），取消在宿主侧是 no-op，指示器由微信自行超时；
  - 配对码登录要用户在手机上读码后填回本机，界面没有这个输入面 —— 遇到时记一行日志并让本次扫码失败；
  - 入站消息不再带 `messageId`（SDK 的线格式里没有该字段，渲染端本来也没读它）；
  - 入站媒体由 SDK 一次性收进内存，20MB 上限只能在落盘前按实际字节数拒绝；
  - 会话过期后的重登由 SDK 内部发起，那条路的二维码没有界面承载，宿主把这件事报成
    `paused` + 「登录态已过期，请重新扫码」。
  - 入站媒体只从固定 CDN 基址下载、出站只朝固定基址上传，服务端下发的任意 URL 不再参与
    取字节（SSRF 面因此消失）；登录下发的 `baseurl` 仍按「https + `qq.com` 域」校验，
    不合规即删掉刚落的凭证并丢弃 SDK 实例。

### 修复

- **HTTPS 部署下登出清不掉会话 cookie**：带 `Secure` 属性的 cookie 按 RFC 6265bis 只能被同样带
  `Secure` 的 `Set-Cookie` 覆盖，而清理用的 `Set-Cookie` 固定不带——TLS 反代之后登出后旧 cookie
  原样留在浏览器里。现与签发共用同一份 `secure_cookie` 配置，清理属性与签发必然一致。
- **opencode 2.0 下宿主权限裁决全线失效**：opencode 2.0 重命名了权限配置（`permission` 对象 +
  `bash` → `permissions` 数组 + `shell`），注入的 v1 形状被静默忽略、默认策略全 allow——agent
  对工具直接执行、从不发 `session/request_permission`，宿主的只读 / 工作区档位就没有裁决入口。
  预设与链路测试改为同时注入 v1 / v2 两种形状（两版本各读各的键互不冲突）。
- **git 查询不再可能永久挂起**：宿主跑 git 用的是 `Command::output()`，既没有超时窗口
  （巨型仓库 / 冷缓存 / 网络盘上的 `status`、`diff` 长时间不出结果时，渲染端会一直转圈），
  也会在管道写满而无人读时死锁。现在改成 spawn + 读线程抽干管道 + 主线程轮询退出状态：
  30 秒未退则整组杀进程并报错，让界面能恢复。
- **微信出站不再把「服务端拒绝」当成发送成功**：业务错误是随 HTTP 200 放在**响应体**里的
  （`ret` / `errcode` 非 0），只看 HTTP 状态会把被丢掉的消息当成功 —— 手机端收不到、桌面端
  却看得见回复。这条判定现由 SDK 统一做（非 0 业务码一律报错），宿主另给每条入站（发送者 /
  条目类型 / token 长度）与每条出站（「已回复」或失败原因）各记一行日志，便于定位
  「第一次能回、后面回不了」这类问题。
- **微信「第一条能回、后面回不了」**：微信的 `context_token` 按条颁发，复用旧 token 会被
  服务端静默丢弃；而自动回复原先在发信那一刻才去读 `peer.contextToken` —— 那永远是最新一条
  的值。第一条还没回完、第二条就到时，第一条的回复会占用第二条的 token，轮到第二条就成了复用。
  现在宿主按 `context_token` 记住每条入站消息，回信（文本与媒体）都走 SDK 的
  `reply` / `reply_media`，凭据与被回复的那条严格对应。
- **`fs_write_binary` 的上限按字节数判定**：此前拿 base64 编码串的长度去比 20MB，而 base64 会
  把载荷撑大约 4/3，导致 20MB 原始文件编码后约 27MB 被误拒，有效上限只有约 15MB。
- 微信入站过滤不再依赖协议里并不可靠的 `message_type`，改判 `item_list` 里是否含可识别的条目 ——
  否则纯媒体消息可能被整条丢弃。
- **切区段 / 切标签 / 关窗不再静默丢掉未保存的编辑**：此前只有「关标签」有确认，而区段切换与
  切标签都会卸载编辑器并注销它的保存器，关窗更是连问都不问 —— 在 xlsx / docx / pptx / 文本里
  改过的内容会无声消失。现在这几条离开路径共用一个策略：**先自动保存，全部成功才继续**，
  写不进去才弹确认（放弃并继续 / 取消），并在保存成功后给一条回执（自动写盘是用户没显式要求
  的动作，界面必须能区分「悄悄存了」与「悄悄没了」）。
  - 关窗走渲染端的 `onCloseRequested`（可就地拦下，无「标志还没推给宿主」的竞态）；托盘
    「退出应用」与 Cmd+Q 走的是 `app.exit`，绕过该事件，改由宿主在 `RunEvent::ExitRequested`
    里用渲染端同步过来的「有无未保存改动」标志拦一次。
  - 「关闭到托盘」为真时点 X 只是隐藏窗口，不丢数据也不弹窗，该分支优先。
- **未知扩展名的二进制文件不再被当文本读成满屏乱码**：`decode_text_bytes` 对非法字节只做
  U+FFFD 替换、从不报错，于是 `.zip` / `.exe` / `.woff` 打开就是一屏占位符，看着像文件坏了。
  宿主新增 `fs_probe_file`（只读前 8KB）判定「像不像二进制」「是不是 UTF-8」「BOM 与行尾」，
  预览据此改给占位；UTF-16 的「字符 + 0x00」交替形态被显式放行，不会误判成二进制。
- **窄屏自动折叠右栏不再丢未保存的改动**：模板里 `PreviewSider` 是 `v-if="preview.available"`，
  窗口变窄就整个卸载 —— 而卸载会注销预览编辑器的 saver，未保存的改动随之消失（与上一轮修的
  区段 / 标签切换是同一类问题，但那条路径当时漏了）。现在「从桌面变窄」先走一遍守卫：
  面板还挂着的状态下自动保存，全部成功才真的收起来；写不进去会挂起确认弹层。
  用户在窄屏选了「取消」之后不再反复追问，直到视口回到桌面重新武装。
- **切走 PDF 不再抛错，也不再漏 worker**：`PDFDocumentProxy.destroy()` 在 pdfjs v6 已被移除
  （只剩 `cleanup()`），预览关闭 / 切标签时那次调用于是抛 `destroy is not a function`，
  worker 一直没被释放 —— 每开一次 PDF 漏一个。现在改为持有加载任务并调它的 `destroy()`。
- **自托管 Web 端的 CSP 不再被自家脚本撞出违规**：`index.html` 里那段首帧主题脚本是内联的，
  在桌面壳与自托管服务端都不含 `'unsafe-inline'` 的策略下会被 `script-src` 拦掉（浅色用户
  会先闪一帧深色），已抽成同源外链 `boot.js`；ACP SDK 依赖的 zod v4 会在构造 schema 时探测
  `new Function` 以决定是否 JIT 编译校验器，这条探测同样会报 `script-src` 违规，现显式关掉
  JIT（校验行为不变）。两处都是「功能上会降级、但控制台与 CSP 报表里始终挂着假警报」的形态。

## [0.3.0] - 2026-09-21

### 新增

- **系统托盘**：托盘菜单可显示/隐藏主窗口、新建对话、打开设置、退出应用；Windows / macOS 上
  左键单击直接切换窗口显隐（Linux 的 `TrayIconEvent::Click` 不派发，走菜单项）。
- **关闭行为可选**（设置 · 系统）：默认「关闭到托盘」（点关闭只隐藏窗口，从托盘「退出应用」
  才真正退出），也可改为「关闭即退出」。窗口首次藏进托盘时发一条系统通知，避免「点关闭后
  应用像是消失了」。
- **全局右键菜单**：标题栏、侧栏导航、会话历史行、文件树、预览标签、预览空态、活动带标签、
  聊天消息各有贴合上下文的条目；输入框补上剪切 / 复制 / 粘贴 / 全选（自绘菜单会拦掉原生
  菜单，不补就没有编辑动作）。

### 变更

- 托盘菜单文案随界面语言切换：宿主不持有语言，文案由渲染端在启动水合与每次切语言时推送。
- 托盘不可用时（Linux 缺 AppIndicator 宿主等）「关闭到托盘」自动回落为「关闭即退出」，
  设置页也改为只给说明、不给无效档位 —— 否则窗口藏起来后没有任何入口能恢复。

### 修复

- **表单控件兜底 reset 与全局焦点环收进 `@layer base`**：此前它们是无层样式，会压过所有
  工具类（无层永远胜出，与特异度无关）。后果是约 20 处声明了 `.border` / `.bg-*` 的输入框
  实际渲染成无边框透明块、`.outline-none` 失效导致点一下冒直角蓝框、`.font-mono` 被
  `font-family: inherit` 压掉、`disabled:cursor-not-allowed` 被 `button { cursor: pointer }` 压掉。
  随之把三个输入框（对话 / 新建对话 / 远程会话）的焦点反馈移到外层卡片的 `focus-within`，
  文字区补一块可见的圆角底面 —— 内层不再自画描边后，得让「输入框」这个本体看得出来。
- 文件操作失败提示（用系统应用打开 / 在文件夹中显示）此前在文件树、预览侧栏、老格式
  Office 查看器里各硬编码一份中文，收口到 `fileOp.*` 并补齐中英文。
- macOS 上窗口隐藏到托盘后点 Dock 图标无法恢复：补 `RunEvent::Reopen` 处理。

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
  最新 Release 并展示新版发布说明，点「前往下载」用系统浏览器打开发布页手动安装。应用不
  内置原地升级（不做 minisign 签名、不产 `latest.json`），全平台走同一套手动下载流程。

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

[0.5.0]: https://github.com/jean3690/GreyWork/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jean3690/GreyWork/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jean3690/GreyWork/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jean3690/GreyWork/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/jean3690/GreyWork/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jean3690/GreyWork/releases/tag/v0.1.0
