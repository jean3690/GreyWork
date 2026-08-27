# @greywork/shell

GreyWork 的宿主/Shell 平台包：会话管理、模型供应商注册表、网页搜索供应商、插件市场与 AI 循环策略。

- 会话：内存实现，可替换为持久化（SQLite / Tauri Store）
- 模型供应商：支持 OpenAI Compatible / Anthropic / Ollama / 自定义
- AI 循环：回合上限、命令守卫、工具白名单与审批规则
