# @greywork/plugins

GreyWork 的技能市场源适配层：skills.sh 官方市场的搜索 / 下载 / 安装传输抽象（桌面 = Tauri IPC 宿主代理；Web 预览 = vite 代理），以及 AI 命令策略的类型契约（执行面在 Rust 宿主 `process_guard`）。

工作台插件系统（manifest / loader / 授权门禁 / 市场）在 `@greywork/workbench` 的 `src/plugins/`，与本包无继承关系。
