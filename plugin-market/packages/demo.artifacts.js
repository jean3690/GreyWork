// artifacts.publish 能力演示插件（plugin-market/packages/demo.artifacts.js，已就绪、未发布）。
//
// 能力语义：把文本产物送进产物面板（与 agent 自己的产出同一个列表）。
//   - 插件只给展示名与内容，落盘路径由宿主净化并限定在 `plugins/<插件 id>/`；
//   - 之后走既有 deliverArtifact：VFS 落盘 + 镜像到工作区 artifacts/ + 广播 artifact:created
//     （查看器自动开 tab）；
//   - 单份 ≤ 256 KiB、md / html / csv 三种格式，每插件 10 分钟最多 20 次；
//   - HTML 由查看器去脚本渲染（sandbox 不含 allow-scripts），所以发布 Markdown 更稳妥。
// 这是前端能力：web 预览（无宿主）也能发布，只是不会镜像到磁盘。
//
// 发布三步（与 demo.workspace 同流程，见 plugin-market/README.md）：
//   1. 把 demo.artifacts.json / demo.artifacts.js 推送到 plugin-market 所在仓库（可先发 PR）；
//   2. `sha256sum packages/demo.artifacts.json`，把 runtime.entry 钉到推送后的提交 SHA，
//      并把 hash 填进 runtime.sha256（entry 必须 pin commit，不能是分支）；
//   3. registry.json 增加条目 → `python3 sign_registry.py --verify`
//      → `cargo test -p greywork-host plugin_market`。

greywork.registerAction("publish", async (state) => {
  const title = typeof state.title === "string" ? state.title.trim() : "";
  const body = typeof state.body === "string" ? state.body : "";
  if (!title) {
    return { status: "先填一个产物名" };
  }
  if (!body.trim()) {
    return { status: "内容为空，没什么可发布的" };
  }
  try {
    const { path } = await greywork.call("artifacts.publish", {
      name: title,
      format: "md",
      data: body,
    });
    return { status: `已发布：${path}`.slice(0, 120) };
  } catch (error) {
    return { status: `发布被拒：${error.message}`.slice(0, 120) };
  }
});
