// workspace.read 能力演示插件（plugin-market/packages/demo.workspace.js，已就绪、未发布）。
//
// 能力语义：读的是**用户已授权的工作区**（与文件树同一张白名单），不是插件私有沙箱。
//   - `roots` 只回授权根（路径 + 目录名）；
//   - `read` 只读根内普通文本文件，单次最多 256 KiB（超出截断，`truncated` 为 true），
//     二进制与目录拒绝；授权失败与文件不存在返回同一句错误。
//   - 只读：没有 write / remove 分支，插件拿不到任何落盘入口。
// workspace.read 没有 webview 等价物：无桌面/服务端宿主时（web 预览）调用直接失败，
// 插件代码会把错误接住并写进 status 字段，而不是抛穿。
//
// 发布三步（与 demo.fs 同流程，见 plugin-market/README.md）：
//   1. 把 demo.workspace.json / demo.workspace.js 推送到 plugin-market 所在仓库（可先发 PR）；
//   2. `sha256sum packages/demo.workspace.json`，把 runtime.entry 钉到推送后的提交 SHA，
//      并把 hash 填进 runtime.sha256（entry 必须 pin commit，不能是分支）；
//   3. registry.json 增加条目 → `python3 sign_registry.py --verify`
//      → `cargo test -p greywork-host plugin_market`。

/** 预览字段只放前 800 字：声明式页面是单行文本，整份文件塞进去没法看。 */
const PREVIEW_CHARS = 800;

greywork.registerAction("roots", async () => {
  try {
    const { roots } = await greywork.call("workspace.read", { op: "roots" });
    if (roots.length === 0) {
      return { status: "还没有已授权的工作区根" };
    }
    const names = roots.map((root) => root.name).join("、");
    return { status: `已授权 ${roots.length} 个根：${names}`.slice(0, 120) };
  } catch (error) {
    return { status: `列出被拒：${error.message}`.slice(0, 120) };
  }
});

greywork.registerAction("read", async (state) => {
  const path = typeof state.path === "string" ? state.path.trim() : "";
  if (!path) {
    return { preview: "", status: "先填一个授权根内的文件路径" };
  }
  try {
    const result = await greywork.call("workspace.read", { op: "read", path });
    const preview = result.data.slice(0, PREVIEW_CHARS);
    const truncated = result.truncated ? "（已截断）" : "";
    return {
      preview,
      status: `${result.name} · ${result.bytes} 字节${truncated}`.slice(0, 120),
    };
  } catch (error) {
    return { preview: "", status: `读取被拒：${error.message}`.slice(0, 120) };
  }
});
