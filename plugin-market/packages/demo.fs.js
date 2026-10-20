// fs.scoped 能力演示插件（plugin-market/packages/demo.fs.js，已就绪、未发布）。
//
// 能力语义：文件落在本插件的**私有沙箱目录**
//   `<app_data>/plugins/demo.fs/files/notes/hello.txt`
// 只接受相对路径（拒绝 `..` / 绝对路径 / 盘符），拒绝符号链接，
// 单文件 1 MiB、每插件总量 8 MiB；只处理 UTF-8 文本。
// fs.scoped 没有 webview 等价物：无桌面/服务端宿主时（web 预览）调用直接失败，
// 插件代码会把错误接住并写进 status 字段，而不是抛穿。
//
// 发布三步（与 demo.kv 同流程，见 plugin-market/README.md）：
//   1. 把 demo.fs.json / demo.fs.js 推送到 plugin-market 所在仓库（可先发 PR）；
//   2. `sha256sum packages/demo.fs.json`，把 runtime.entry 钉到推送后的提交 SHA，
//      并把 hash 填进 runtime.sha256（entry 必须 pin commit，不能是分支）；
//   3. registry.json 增加条目 → `python3 sign_registry.py --verify`
//      → `cargo test -p greywork-host plugin_market`。

greywork.registerAction("save", async (state) => {
  const note = typeof state.note === "string" ? state.note : "";
  try {
    await greywork.call("fs.scoped", {
      op: "write",
      path: "notes/hello.txt",
      data: note,
    });
    return { status: "已写入沙箱文件" };
  } catch (error) {
    return { status: `保存被拒：${error.message}` };
  }
});

greywork.registerAction("load", async () => {
  try {
    const { exists, data } = await greywork.call("fs.scoped", {
      op: "read",
      path: "notes/hello.txt",
    });
    if (!exists) return { status: "文件还不存在（先点保存）" };
    return { note: data ?? "", status: "已从沙箱文件读回" };
  } catch (error) {
    return { status: `读取被拒：${error.message}` };
  }
});
