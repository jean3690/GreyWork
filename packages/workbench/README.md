# @greywork/workbench

GreyWork 的共享工作台 UI 包：桌面端与 Web 端共用的完整界面（外壳、对话与 Agent 编排、
文件预览、定时任务、渠道、设置、插件市场）。

- 依赖领域包：`acp` / `agents` / `core` / `cowork` / `editor` / `host-ipc` / `llm` / `plugins` / `shell`
- 由 `Shell`（以及登录门 `AuthGate`）作为单一入口导出，宿主壳负责挂载
