# @greywork/editor

工作区能力包：文件系统、Git 版本控制、CodeMirror 编辑器与文档/表格预览的抽象层。

- 当前提供内存 Mock（文件系统 + Git）
- 真实实现可对接 tauri-plugin-fs、CodeMirror 6、git2 或 WebAssembly git
