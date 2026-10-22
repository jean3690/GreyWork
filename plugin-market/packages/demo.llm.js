// llm.chat 能力演示插件（plugin-market/packages/demo.llm.js，已就绪、未发布）。
//
// 能力语义：一次单轮模型补全。
//   - 插件只传 prompt / system / model，**永远拿不到密钥**；
//   - 宿主按当前设置解析供应商（baseUrl + 密钥环境变量名），插件改不了端点；
//   - 模型必须落在 manifest 的 models 白名单内（这里只有 gpt-4o-mini），
//     不在白名单的 id 在触达宿主前就被拒绝；
//   - prompt ≤ 8 KiB、system ≤ 2 KiB，每插件 10 分钟最多 20 次。
// llm.chat 没有 webview 等价物：无桌面/服务端宿主时（web 预览）调用直接失败，
// 插件代码把错误接住写进 status，而不是抛穿。
//
// 发布三步（与 demo.workspace 同流程，见 plugin-market/README.md）：
//   1. 把 demo.llm.json / demo.llm.js 推送到 plugin-market 所在仓库（可先发 PR）；
//   2. `sha256sum packages/demo.llm.json`，把 runtime.entry 钉到推送后的提交 SHA，
//      并把 hash 填进 runtime.sha256（entry 必须 pin commit，不能是分支）；
//   3. registry.json 增加条目 → `python3 sign_registry.py --verify`
//      → `cargo test -p greywork-host plugin_market`。

/** 回复字段只放前 800 字：声明式页面是单行文本，整段回复塞进去没法看。 */
const ANSWER_CHARS = 800;

greywork.registerAction("summarize", async (state) => {
  const prompt = typeof state.prompt === "string" ? state.prompt.trim() : "";
  if (!prompt) {
    return { answer: "", status: "先填一段要摘要的文本" };
  }
  try {
    const { text, model } = await greywork.call("llm.chat", {
      prompt,
      system: "把用户给出的文本压缩成一句话，只输出那句话。",
    });
    return {
      answer: text.slice(0, ANSWER_CHARS),
      status: `${model} · ${text.length} 字`.slice(0, 120),
    };
  } catch (error) {
    return { answer: "", status: `调用被拒：${error.message}`.slice(0, 120) };
  }
});
