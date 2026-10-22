// clipboard 能力演示插件（plugin-market/packages/demo.clipboard.js，已就绪、未发布）。
//
// 能力语义：读 / 写系统剪贴板，**读写默认不对称**。
//   - 字符串形态 `"clipboard"` 只给 write；
//   - 读必须声明 `{ capability: "clipboard", ops: ["read"] }`（本包 read + write 都要）；
//   - 单次 ≤ 64 KiB（读取超长会截断并带 truncated 标记），每插件 1 分钟最多 20 次；
//   - 审计只记长度，剪贴板内容绝不落日志。
// 宿主门面按运行时选路：Electron 走主进程 clipboard，浏览器态走 Web API（可能需要用户手势，
// 被拒时按普通错误上抛，这里接住写进 status）。
//
// 发布三步（与 demo.workspace 同流程，见 plugin-market/README.md）：
//   1. 把 demo.clipboard.json / demo.clipboard.js 推送到 plugin-market 所在仓库（可先发 PR）；
//   2. `sha256sum packages/demo.clipboard.json`，把 runtime.entry 钉到推送后的提交 SHA，
//      并把 hash 填进 runtime.sha256（entry 必须 pin commit，不能是分支）；
//   3. registry.json 增加条目 → `python3 sign_registry.py --verify`
//      → `cargo test -p greywork-host plugin_market`。

/** 读回内容只放前 800 字：声明式页面是单行文本。 */
const PASTED_CHARS = 800;

greywork.registerAction("copy", async (state) => {
  const text = typeof state.text === "string" ? state.text : "";
  try {
    await greywork.call("clipboard", { op: "write", text });
    return { status: `已写入 ${text.length} 字`.slice(0, 120) };
  } catch (error) {
    return { status: `写入被拒：${error.message}`.slice(0, 120) };
  }
});

greywork.registerAction("paste", async () => {
  try {
    const { text, truncated } = await greywork.call("clipboard", { op: "read" });
    const suffix = truncated ? "（已截断）" : "";
    return {
      pasted: text.slice(0, PASTED_CHARS),
      status: `读回 ${text.length} 字${suffix}`.slice(0, 120),
    };
  } catch (error) {
    return { pasted: "", status: `读取被拒：${error.message}`.slice(0, 120) };
  }
});
