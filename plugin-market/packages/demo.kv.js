// storage.kv 能力演示插件（plugin-market/packages/demo.kv.js，已就绪、未发布）。
//
// 能力语义：页面字段（note）由宿主渲染在声明式状态（declarativeState）里；
// storage.kv 是本插件的**私有**持久化存储 —— 任意 JSON 值、按插件隔离、
// 每插件总量 256 KiB / 单值 64 KiB。字段状态与私有存储互不干扰。
//
// 发布三步（与 demo.worker 同流程，见 plugin-market/README.md）：
//   1. 把 demo.kv.json / demo.kv.js 推送到 plugin-market 所在仓库（可先发 PR）；
//   2. `sha256sum packages/demo.kv.json`，把 runtime.entry 钉到推送后的提交 SHA，
//      并把 hash 填进 runtime.sha256（entry 必须 pin commit，不能是分支）；
//   3. registry.json 增加条目 → `python3 sign_registry.py --verify`
//      → `cargo test -p greywork-host plugin_market`。

greywork.registerAction("save", async (state) => {
  const note = typeof state.note === "string" ? state.note : "";
  try {
    await greywork.call("storage.kv", {
      op: "set",
      key: "note",
      value: { text: note, savedAt: Date.now() },
    });
    return { status: "已保存到插件存储" };
  } catch (error) {
    return { status: `保存被拒：${error.message}` };
  }
});

greywork.registerAction("load", async () => {
  try {
    const { value } = await greywork.call("storage.kv", { op: "get", key: "note" });
    const text = value && typeof value.text === "string" ? value.text : "（存储里还没有备注）";
    return { note: text, status: "已从插件存储读回" };
  } catch (error) {
    return { status: `读取被拒：${error.message}` };
  }
});
