// net.fetch v2 能力演示插件（plugin-market/packages/demo.fetch.js，已就绪、未发布）。
//
// 能力语义（v2）：
//   - GET/HEAD 只需 host 白名单；POST 必须同时在 manifest 的 paths 里声明路径模板；
//   - 路径模板：`*` 匹配段内任意字符、整段 `**` 匹配零个或多个路径段；
//   - 请求体只允许随 POST 携带，且先按声明的 maxBytes 校验（默认 1 MiB，封顶 8 MiB）；
//   - 每插件每分钟最多 30 次；web 预览走受限 webview fetch，桌面态走 Rust 代理（二次校验）。
//   本包声明 hosts=["postman-echo.com"], methods=["GET","POST"], paths=["/get","/post"]。
//
// 发布三步（与 demo.kv / demo.fs / demo.notify 同流程，见 plugin-market/README.md）：
//   1. 把 demo.fetch.json / demo.fetch.js 推送到 plugin-market 所在仓库（可先发 PR）；
//   2. `sha256sum packages/demo.fetch.json`，把 runtime.entry 钉到推送后的提交 SHA，
//      并把 hash 填进 runtime.sha256（entry 必须 pin commit，不能是分支）；
//   3. registry.json 增加条目 → `python3 sign_registry.py --verify`
//      → `cargo test -p greywork-host plugin_market`。

function readMessage(state) {
  return typeof state.message === "string" && state.message.trim() !== "" ? state.message.trim() : "hello greywork";
}

// GET：host 白名单放行即达。
greywork.registerAction("get", async (state) => {
  const message = readMessage(state);
  try {
    const res = await greywork.call("net.fetch", {
      url: `https://postman-echo.com/get?msg=${encodeURIComponent(message)}`,
    });
    return { status: `GET ${res.status} · host 白名单放行` };
  } catch (error) {
    return { status: `GET 被拒：${error.message}` };
  }
});

// POST：路径模板匹配 /post 才放行，请求体随 body 透传。
greywork.registerAction("post", async (state) => {
  const message = readMessage(state);
  try {
    const res = await greywork.call("net.fetch", {
      url: "https://postman-echo.com/post",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    return { status: `POST ${res.status} · 路径模板放行` };
  } catch (error) {
    return { status: `POST 被拒：${error.message}` };
  }
});
