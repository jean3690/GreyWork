# 插件系统能力展望（Roadmap）

> 姊妹篇：[`plugin-authoring.md`](./plugin-authoring.md) 讲「现在能写什么」，本篇讲「未来能写什么、
> 按什么顺序做、每一步动哪些代码」。所有结论都以当前代码为锚点，并非空想清单。
>
> 一句话总结：**插件机制的骨架已经很完整，缺的是「能力目录」与「贡献面」的宽度，以及把
> 分发生态做厚的功夫。** 未来的主线就是把宿主已有的领域（工作台文件、MCP、LLM、自动化、
> 通知、剪贴板……）逐个转成受控能力，再把渲染与分发升级到能让插件「好用、好写、好信任」。

---

## 1. 现状基线（30 秒回顾）

机制侧是完备的，能力侧是收缩的：

| 维度     | 现状                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生命周期 | Cordis 微内核注册/启停/卸载、`dependsOn` 拓扑、被依赖拒卸（`loader.ts`）✅                                                                                            |
| 安全     | 包 SHA-256、registry ed25519 签名、按插件隔离授权、worker 无 DOM/无定时器 ✅                                                                                          |
| 能力目录 | `net.fetch`（GET/HEAD + 声明式 POST/路径模板/配额）、`storage.kv`、`fs.scoped`、`workspace.read`、`notify`、`schedule`、`window.floating`、`plugin-admin`（不可调用） |
| 贡献面   | 3 种：全页 `modes`、3 个宿主 `uiRegions`、悬浮窗 `window`                                                                                                             |
| 渲染     | 封闭 SVG 指令白名单（`circle/ellipse/rect/path/text/group`）+ 指针事件回传（`render.pointer` → `registerPointer`，坐标有界、补丁同动作通道）                          |
| 分发     | 单 registry、`entry` 钉死 GitHub commit、无 dev 模式                                                                                                                  |

**扩展点是且仅是三条**：能力目录（加能力）、贡献面（加挂载点）、分发通道（加体验）。下面是按这三条展开的分期路线图。

---

## 2. 总体原则（不破坏现有模型的约束）

1. **任何新能力都是一等公民**：进 `packages/workbench/src/plugins/capabilities.ts` 的
   `CAPABILITY_REGISTRY` + Rust 侧对应命令，走「声明 → 授权 → 调用实时三重校验」既有管线，
   不搞旁路。
2. **worker 无 DOM、无副作用原则不变**。一切有副作用/有状态的动作由宿主执行，worker 只发
   请求、收结果（`greywork.call` 是唯一出口）。
3. **默认拒绝、最小特权、可审计**：每个新能力都要定 danger 级、授权形态（字符串 or 带参数的
   对象）、调用时校权，审计进入现有 `capabilityAuditLog`。
4. **服务端（headless）同步受益**：能力实现尽量落在 `greywork_host`（桌面/server 共享），
   宿主壳只留薄壳。

---

## 3. 分期路线图

### P0 · 基础能力补齐（近期 · 不依赖工作台内部域）

把「插件现在明显缺的基础设施」补上，每项都能单独落地：

| 能力           | 解决什么                                                                                    | 关键设计                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 代码锚点                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.kv`   | 插件需要自己的持久化数据，而现在只有 `declarativeState` 的 `string/number/boolean` 平面结构 | ✅ **已实现**：插件级命名空间 KV（`pluginId` 隔离），值可为任意 JSON，总量 256 KiB / 单值 64 KiB；键名白名单 + JSON 安全校验 + 审计；实现即 `declarativeState` 的宿主化泛化                                                                                                                                                                                                                                                                                                                                                                                     | `capabilities.ts` 的 `storageKvCapability`；单测 `tests/unit/plugins/capabilities.storage.test.ts`、e2e 见 `__tests__/storage-kv-e2e.dom.test.ts`；演示包 `plugin-market/packages/demo.kv.{json,js}`（待发布）                                                                                                                                                                                                                                            |
| `fs.scoped`    | 插件想落日志/图片缓存/模型文件，现在完全没有文件通道                                        | ✅ **已实现**：每插件沙箱 `<app_data>/plugins/<id>/files/`，读写/删除/枚举/统计（read/write/remove/list/stat），相对路径白名单（复用 `path_safety` 净化）+ 拒符号链接，单文件 1 MiB / 每插件 8 MiB，原子写；文本 UTF-8（二进制留 v2），无宿主（web 预览）时调用直接失败；命令 `plugin_fs`（Rust `plugin_fs.rs`，已入 `COMMANDS` 与桌面 `generate_handler`）                                                                                                                                                                                                     | `plugin_fs.rs` 的 `plugin_fs`；`capabilities.ts` 的 `fsScopedCapability`；单测 `tests/unit/plugins/capabilities.fs.test.ts`、e2e `__tests__/fs-scoped-e2e.dom.test.ts`                                                                                                                                                                                                                                                                                    |
| `notify`       | 桌面包没法弹系统通知                                                                        | ✅ **已实现**：worker 发 `{title, body}`；宿主复核长度（标题 ≤64 / 正文 ≤240，按码点）与控制字符，标题统加 `[plugin-id]` 归属前缀（插件无法伪装成宿主通知）；前端 broker 限速 10/min + 审计；命令 `plugin_notify` 登记为 desktop 专属（headless `dispatch` 明确拒绝），桌面壳 `notify::send` 投递（失败仅记日志，绝不影响主流程）；`icon?` 延后（需路径沙箱，roadmap 草案项按落地评审收敛）                                                                                                                                                                     | greywork-host `plugin_market/plugin_notify.rs`（`compose_plugin_notify`）+ `capabilities.ts` 的 `notifyCapability`；单测 `tests/unit/plugins/capabilities.notify.test.ts`、e2e `__tests__/notify-e2e.dom.test.ts`；演示包 `plugin-market/packages/demo.notify.{json,js}`（待发布）                                                                                                                                                                        |
| `schedule`     | worker 没有定时器，插件无法「后台干活」（现在只能在被打开/被渲染时被动结算）                | ✅ **已实现**：插件参数化声明 `{ "capability": "schedule", "schedule": { "kind": "interval", "min": 5 } }`（安装期 Rust 校验形态与 5–1440 分钟边界）；宿主持调度器在工作台侧挂钟——挂载面（`uiRegion`）存活期间每隔 `min` 分钟唤醒 worker 的 `registerSchedule` 处理器，补丁复用动作通道合并进区域状态；不在内存时跳过、下次激活补结算一次（`nextDue` 持久化在 `greywork.plugins.schedule.due`）；授权门禁由 `effectiveRegionSchedule`（声明 + 已授权）收敛，未授权不挂钟；命令不新增（调度器即前端引擎，worker 侧 `call("schedule")` 明确拒绝），web 预览也可用 | `plugins/scheduler.ts`（引擎）、`declarative.ts`（adapter 传 prop）、`PluginRegionHost.vue`（挂钟）、`code-runtime.ts`（prelude `registerSchedule`）；Rust `dto.rs`/`package.rs`（`ManifestSchedule` 校验）；单测 `tests/unit/plugins/scheduler.test.ts`、`capabilities.schedule.test.ts`、真·Vue `__tests__/schedule-region.dom.test.ts`、全链路 `__tests__/schedule-e2e.dom.test.ts`；演示包 `plugin-market/packages/demo.schedule.{json,js}`（待发布） |
| `net.fetch` v2 | 现在 GET/HEAD + 1 MiB，做不了像样的网络功能                                                 | ✅ **已实现（非流式部分）**：声明式 `{ hosts, methods?, paths?, maxBytes? }` —— `methods` 缺省 GET/HEAD，可选 POST；声明 POST 时必须给 1-8 条路径模板（`*` 段内 / `**` 跨段，仅 POST 受路径约束，GET/HEAD 仍按 host）；`body` 仅 POST 且受 `maxBytes` 约束（1 KiB–8 MiB，缺省 1 MiB）；前端 broker + Rust 代理双重校验方法/路径/字节，限速仍 30/min。optional `stream`（宿主转 chunk 事件）暂缓，见下方备注                                                                                                                                                     | `capabilities.ts::netFetchCapability`、`net_fetch.rs`（+ `dto.rs`/`package.rs` 声明校验）；单测 `tests/unit/plugins/capabilities.netfetch.test.ts`、e2e `__tests__/capability-e2e.dom.test.ts`；演示包 `plugin-market/packages/demo.fetch.{json,js}`（待发布）                                                                                                                                                                                            |
| 渲染指针事件   | 渲染是单向的，交互只能靠按钮，做不了可点的画布小工具                                        | ✅ **已实现**：manifest 在 `runtime.render` 里声明 `"pointer": true`（Rust `RenderLoop.pointer`，缺省 false）；宿主监听画布的 `pointerdown/move/up/cancel/leave`，把坐标归一化（`x/y` 裁到画布内、`nx/ny` 为 [0,1]）后经指针通道交给 worker 的 `registerPointer`，返回的状态补丁走 `isPatch` 并入同一份渲染状态（下一帧可见）。事件在宿主侧构造、`type` 为封闭枚举；派发串行（`move` 合并、离散事件保序）；非能力、不新增命令，仅声明门禁。悬浮窗（`PluginWindowView`）仍为拖拽面，不接指针                                                                     | `PluginRenderLoop.vue`（事件/归一化/串行派发）、`code-runtime.ts`（prelude `registerPointer` + `dispatchPointer`）、`declarative.ts` / `DeclarativePluginView.vue` / `PluginRegionHost.vue`（接线与补丁合并）；Rust `dto.rs`（`RenderLoop.pointer`）；单测 `tests/unit/plugins/pointer-prelude.test.ts`、`code-runtime.dom.test.ts`、真·Vue `__tests__/render-pointer.dom.test.ts`；演示包 `plugin-market/packages/demo.pointer.{json,js}`（待发布）      |

> **`net.fetch` v2 流式（`stream`）暂缓**：把响应切成 chunk 事件回传 worker，要求 worker 的
> host-call 通道从「一次调用 → 一次响应回执」扩成「一次调用 + 多次事件」—— 要动 `code-runtime.ts`
> 的 prelude 消息模型、宿主 `plugin_net_fetch` 的流式转发、以及 worker 侧 API，属于独立的一档增量。
> 非流式的 `POST` / 路径模板 / 按声明配额已完整闭环，足以支撑 P0 判据（行情轮询走 `GET` 即可）；
> 流式作为 `net.fetch` 的后续增量再推进。

**P0 完成判据**：能写出「每小时抓一次行情 → 存进 `fs.scoped` → 弹通知 → 画布上可点击」的插件而不需要宿主改一行业务代码之外的东西。（P0 各项均已 ✅，该判据已可达。）

### P1 · 接入工作台域（插件从「挂件」升级为「工作台公民」）

这是质变的一档：把宿主已经存在的领域能力逐个暴露，插件开始能碰「工作台的数据」。

| 能力                | 解决什么                                                   | 关键设计                                                                                                                                                                                                                                    | 宿主已有的地基                                                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.read`    | 插件读授权工作区内的文件（只读，隔离每个 root）            | ✅ **已实现**：复用 `WorkspaceFsAccess::resolve_existing` / `authorized_roots`（**不新建第二张白名单**）；`roots` 列授权根，`read` 只读根内文本文件（单次 256 KiB 截断、二进制/目录拒绝、授权失败与不存在同一句错误）；无宿主时 denied 审计 | `infra/workspace_fs/`；`plugin_workspace.rs` 的 `plugin_workspace`；`capabilities.ts` 的 `workspaceReadCapability`；单测 `plugin_workspace.rs` + `tests/unit/plugins/capabilities.workspace.test.ts`；demo `demo.workspace.*` |
| `llm.chat`          | 插件做「智能动作」（摘要、分类、翻译）                     | 一次模型回合，凭证永远在宿主侧；插件只能传 prompt/模型参数模板，不能抄走 key；限流与 agent 共用额度                                                                                                                                         | `services/llm/`、`llm_chat_start`                                                                                                                                                                                             |
| `mcp.connect`       | 插件声明要连某个 MCP server，复用现有 MCP 市场与客户端     | 插件 manifest 里声明 server 配置，宿主代理连接与调用（插件不直接持凭证）；危险级按暴露的工具面定                                                                                                                                            | `services/mcp*.rs`、`McpMarketSection.vue`                                                                                                                                                                                    |
| `clipboard`         | 插件读/写系统剪贴板                                        | 复用宿主剪贴板桥（桌面壳主进程 / 浏览器降级）；读剪贴板默认拒绝、写入默认允许但可配置                                                                                                                                                       | `packaging.md` 的「No Runtime Web Clipboard」设计约束                                                                                                                                                                         |
| `artifacts.publish` | 插件把产物（文本/JSON/小文件）送进会话产物面板，用户可预览 | 写入宿主产物目录，复用预览 viewer 分发（`lib/viewer.ts`）                                                                                                                                                                                   | `activity.artifacts`、`ViewerKind` 表                                                                                                                                                                                         |
| 多窗口/窗口控制 v2  | 悬浮窗只有开/关                                            | `window.floating` 扩展：标题、置顶切换、透明度、位置持久化、多实例；句柄仍不交插件                                                                                                                                                          | `plugin_window.rs`                                                                                                                                                                                                            |

**P1 完成判据**：出现「读取工作区 README → LLM 总结 → 写入产物面板 → 一键复制」的插件，全部动作都可见、可审计、可撤销授权。

### P2 · 新贡献面（插件不再只有「页面 + 区域」）

| 贡献面       | 形态                                                                         | 例子                                         |
| ------------ | ---------------------------------------------------------------------------- | -------------------------------------------- |
| 命令面板条目 | 声明式：`commands: [{id, title, invoke                                       | handler}]`                                   | 插件把自己的动作送进全局命令面板（⌘K） |
| 键盘快捷键   | `keybindings: [{id, key, when}]`                                             | 画布工具 `Cmd+1/2/3` 切工具                  |
| 上下文菜单   | `contextMenu: [{id, label, targets: ["preview","fileTree","conversation"]}]` | 在文件树上「用 XX 插件打开」                 |
| 设置项       | `settingsSchema`：插件往设置页注入自己的表单区块                             | 每个插件把配置放回统一的设置中心而非自建页面 |
| 状态栏       | `statusBar: [{id, label, mode}]`                                             | 常驻显示「轮询中/上次成功」                  |
| 编辑区装饰   | `editorHooks`（后续，最难，需先定义宿主 API 的 key 依据）                    | 代码区行内提示                               |

`contributes` 里已有 `capabilities?: string[]` 的「能力清单字段」注释明确写着「未来宿主 API 的 key 依据」——这一档就是把它兑现。注意每个新贡献面都要**重新走一遍冲突检测**（仿 `assertContributionIds`）与权限门禁。

**P2 完成判据**：插件中心里任意插件的「能干什么」一目了然（贡献面列表 + 能力列表），卸载插件时它的命令/快捷键/菜单全部消失且无残留。

### P3 · 生态与分发（从「能写」到「好写、好分、可信任」）

| 主题                      | 内容                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dev 模式                  | dev 构建允许 `runtime.entry` 指向本地 `http://localhost`（仅 dev 门禁），配 HMR：改代码 → worker 重启 → 状态保留                                      |
| 插件脚手架 CLI            | `greywork plugin init <id>` 生成目录骨架 + manifest + TS 入口 + 测试壳；`greywork plugin dev`、`greywork plugin pack`（打 zip 含资源文件）            |
| 类型包                    | `@greywork/plugin-types`：worker prelude（`greywork` 全局）与 render 指令、能力签名的 TS 类型，让插件代码可类型检查、可引第三方 registry 类型         |
| 多 registry 与包级签名    | registry 级签名之外，给**每个包**加 ed25519 签名（发布者密钥），第三方 registry 可声明「只信签名包」；`OFFICIAL_REGISTRY_PUBLIC_KEY` 逻辑泛化成信任集 |
| 运行时升级                | 新增 `wasm` 运行时（quickjs/wasmtime 宿主内嵌）承载 CPU 重活（数据处理、编解码），与 `worker` 并存为第二沙箱档位；明确 `native` 永不开放给第三方      |
| 资产与 `PluginPackage` v2 | 单 JS 演进为 zip（资源、locale、TS 源），`code` 注入机制升级为资产清单注入；`schemaVersion` 递增留好迁移路径（`manifest.code` 注释已预留）            |
| 市场运营                  | 下载/评分/验证发布者徽标、自动化安全扫描（模板/静态检查入 CI）、版本渠道（stable/beta/canary 对应 registry 多文件）、沙箱内预览                       |
| 国际化                    | manifest 文案支持 locale 键；`uiRegions` 标题不再「不做 i18n」，按包内资源携带                                                                        |

**P3 完成判据**：一个第三方作者能在 10 分钟内 `greywork plugin init` → 本地 dev 起效 → 打包 → 签名 → 提交自己的 registry，用户安装时宿主按发布者信任链验证。

---

## 4. 能力矩阵（未来全景）

> danger 与授权形态仅为草案，落地时按惯例逐一评审（`net.fetch` 是「声明式参数授权」的样板）。

| 能力                 | 危险级   | 授权形态                               | 依赖面                                          | 归属阶段          |
| -------------------- | -------- | -------------------------------------- | ----------------------------------------------- | ----------------- |
| `storage.kv`         | low      | 字符串                                 | 前端模块                                        | P0                |
| `fs.scoped`          | medium   | 字符串                                 | Rust 新增 `plugin_fs_*` → 已新增 `plugin_fs`    | P0 ✅             |
| `notify`             | low      | 字符串                                 | 已有 `notify.rs` → 已落地 `plugin_notify`       | P0 ✅             |
| `schedule`           | low      | `{kind:"interval", min}`               | 前端调度器（工作台持有 worker）                 | P0 ✅             |
| `net.fetch` v2       | medium   | `{hosts, methods?, paths?, maxBytes?}` | `net_fetch.rs` 扩展（`stream` 留后续）          | P0 ✅（流式待做） |
| `window.floating` v2 | medium   | `{windows:[...]}`                      | `plugin_window.rs`                              | P1                |
| `workspace.read`     | high     | root 白名单                            | `workspace_fs` 复用 → 已落地 `plugin_workspace` | P1 ✅             |
| `llm.chat`           | high     | 模型模板白名单                         | `services/llm`                                  | P1                |
| `mcp.connect`        | high     | server 配置声明                        | `services/mcp*`                                 | P1                |
| `clipboard`          | medium   | 读默认拒/写默认许                      | 宿主剪贴板桥（Electron 主进程）                 | P1                |
| `artifacts.publish`  | medium   | 字符串                                 | 产物目录 + viewer                               | P1                |
| `run.command`        | **不做** | —                                      | 至多经 `process_guard` 白名单给**用户自签**包   | 长期              |
| `wasm` 运行时        | —        | —                                      | 宿主嵌入式解释器                                | P3                |

---

## 5. 安全与信任演进

1. **包级签名优先于任何新能力**：现在信任根只在 registry 一条链上；多 registry 时代必须给
   「发布者 → 包」的签名，否则第三方源永远是「自担风险」。建议每包 `signature` 字段 + 发布者
   公钥注册表（仿 `sign_registry.py` 的做法做 Rust 侧验证）。
2. **能力令牌与一次性授权**：`net.fetch` 之外的高危能力（`workspace.read`、`llm.chat`）应支持
   「本次会话一次性放行 / 短 TTL 授权」，授权弹窗展示精确语义（已有 preview 弹窗的基础）。
3. **审计增强**：现在审计是 200 条环形缓冲 + localStorage；插件接入工作台域后应升级为可导出、
   可清空、UI 可筛选（按能力/插件/时间）的记录，并纳入「最近权限活动」一类的入口。
4. **沙箱分级**：`worker`（现状）→ `wasm`（P3）→ `native`（永不）。定级写进 manifest，插件
   中心展示，用户对「能跑什么档位的代码」有清晰预期。
5. **供应链**：worker 代码目前钉 commit + SHA-256，已经是供应链友好的起点；补上包签名 + 发布者
   身份后即完整。

---

## 6. 建设顺序与里程碑

```text
M1（P0）  基础能力补齐        → 批量「数据 + 通知 + 定时」类插件的可行性
M2（P1）  接入工作台域        → 插件开始产生工作台价值，而非只是装饰
M3（P2）  新贡献面            → 插件融入外壳交互（命令/快捷键/菜单/设置）
M4（P3）  生态与分发          → 第三方生态成立的前提
安全前置   包级签名            建议在 M2 启动前完成（多 registry 是 M4 的门）
```

每个里程碑的验收都以「能写出什么样的插件」来衡量，而不是「加了多少行代码」：

- M1 验收：时钟/行情/提醒类插件无需宿主改动业务代码。
- M2 验收：文件 → LLM → 产物流转插件落地且全程可审计。
- M3 验收：任意插件可在不 fork 外壳的前提下长出命令、快捷键、菜单、设置项。
- M4 验收：第三方作者全流程自助（脚手架 → dev → 打包签名 → 自有 registry → 用户可信安装）。

---

## 7. 与既有设计的兼容性声明

- 现有 3 个 demo（counter / worker / pet）不因任何阶段而破坏（`schemaVersion: 1` 保持可解析，新增
  字段一律 optional）。
- `uiRegions` / `modes` 的注册冲突检测、授权门禁、`dependsOn` 拓扑逻辑全部原样复用，不推翻重写。
- worker prelude 的 `greywork` 全局走语义化扩展（新增方法不打乱既有调用），长期需要 break 时以
  `runtime.type` 新值（如 `worker@2`）并存过渡。
