// notify 能力演示插件（plugin-market/packages/demo.notify.js，已就绪、未发布）。
//
// 能力语义：弹一条**系统通知**。宿主校验并合成文案：
//   - 标题自动加 `[demo.notify] ` 归属前缀（插件无法伪装成宿主通知）；
//   - 标题 ≤64 / 正文 ≤240 字符（按码点），标题禁控制字符、正文仅放行换行；
//   - 每插件每分钟最多 10 条（前端 broker 限速 + 审计）；
//   - 仅桌面/服务端宿主可投递；web 预览下调用失败，插件把错误接住写进 status。
//
// 发布三步（与 demo.kv / demo.fs 同流程，见 plugin-market/README.md）：
//   1. 把 demo.notify.json / demo.notify.js 推送到 plugin-market 所在仓库（可先发 PR）；
//   2. `sha256sum packages/demo.notify.json`，把 runtime.entry 钉到推送后的提交 SHA，
//      并把 hash 填进 runtime.sha256（entry 必须 pin commit，不能是分支）；
//   3. registry.json 增加条目 → `python3 sign_registry.py --verify`
//      → `cd apps/desktop/src-tauri && cargo test plugin_market`。

greywork.registerAction("ping", async (state) => {
  const title = typeof state.title === "string" && state.title.trim() !== "" ? state.title.trim() : "构建完成";
  const body = typeof state.body === "string" && state.body.trim() !== "" ? state.body.trim() : "所有测试通过";
  try {
    await greywork.call("notify", { title, body });
    return { status: "已请求系统通知" };
  } catch (error) {
    return { status: `通知被拒：${error.message}` };
  }
});
