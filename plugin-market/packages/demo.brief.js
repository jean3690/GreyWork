// demo.brief：P1 判据的端到端演示 —— 一条动作串起四个能力。
//
// 链路：workspace.read（读授权工作区的 README）→ llm.chat（三行摘要）
//       → artifacts.publish（Markdown 进产物面板）→ clipboard（摘要进剪贴板）。
// 四个能力全部走「声明 → 授权 → 调用时实时校验」，缺任何一个授权都会在对应那一步失败，
// 而不会拖垮整条链路之前的成果；步骤流水写进 steps 字段，用户一眼能看出卡在哪。
//
// 能力语义速记：
//   - workspace.read：只读、只在授权根内、单次 256 KiB 截断，读不了就与不存在同一句错误；
//   - llm.chat：模型必须落在 manifest 的 models 白名单内，密钥与端点全在宿主侧，插件拿不到；
//   - artifacts.publish：只给展示名与内容，路径由宿主净化并限定在 plugins/<id>/，单份 ≤ 256 KiB；
//   - clipboard：这里只声明了 write（读需要显式 ops: ["read"]，本插件用不上）。
//
// 发布三步（与 demo.llm 同流程，见 plugin-market/README.md）：
//   1. 把 demo.brief.json / demo.brief.js 推送到 plugin-market 所在仓库（可先发 PR）；
//   2. `sha256sum packages/demo.brief.json`，把 runtime.entry 钉到推送后的提交 SHA，
//      并把 hash 填进 runtime.sha256（entry 必须 pin commit，不能是分支）；
//   3. registry.json 增加条目 → `python3 sign_registry.py --verify`
//      → `cargo test -p greywork-host plugin_market`。

/** 摘要字段只放前 800 字：声明式页面是单行文本。 */
const SUMMARY_CHARS = 800;
/** 送进模型与产物的原文摘录上限：llm.chat 的 prompt 上限是 8 KiB，留足说明文字的余量。 */
const EXCERPT_CHARS = 1200;
/** 步骤流水字段的长度上限（与 manifest 的 maxLength 对齐）。 */
const STEPS_CHARS = 240;

/** 跑一步：成功记 ✓ 并交回结果，失败记 ✗ 并交回错误 —— 由调用方决定是否继续。 */
async function attempt(steps, label, run) {
  try {
    const value = await run();
    steps.push("✓ " + label);
    return { ok: true, value };
  } catch (error) {
    steps.push("✗ " + label);
    return { ok: false, error };
  }
}

/** 提前收尾：把已走过的步骤与失败原因一起交回，界面不会只剩一句「失败」。 */
function stop(steps, reason) {
  return {
    steps: steps.join(" · ").slice(0, STEPS_CHARS),
    status: String(reason).slice(0, 120),
  };
}

function reasonOf(error) {
  return error && error.message ? error.message : String(error);
}

/** 统一换行、去首尾空白，超长截断并留省略号 —— 模型和产物都吃这份摘录。 */
function excerptOf(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (normalized.length <= EXCERPT_CHARS) return normalized;
  return normalized.slice(0, EXCERPT_CHARS) + "…";
}

/** 产物正文：摘要 + 原文摘录 + 生成时间，够用户回看，也不至于把整份 README 抄一遍。 */
function briefMarkdown(fileName, summary, excerpt) {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return [
    "# " + fileName + " 速览",
    "",
    "> 由 demo.brief 生成 · " + stamp,
    "",
    "## 摘要",
    "",
    summary,
    "",
    "## 原文摘录（前 " + EXCERPT_CHARS + " 字）",
    "",
    excerpt,
    "",
  ].join("\n");
}

greywork.registerAction("brief", async (state) => {
  const steps = [];
  const wanted = typeof state.path === "string" ? state.path.trim() : "";

  // 1. 定位文件：没填路径就取第一个授权根下的 README.md。
  let path = wanted;
  if (!path) {
    const located = await attempt(steps, "列授权根", () => greywork.call("workspace.read", { op: "roots" }));
    if (!located.ok) return stop(steps, "列授权根失败：" + reasonOf(located.error));
    const roots = (located.value && located.value.roots) || [];
    if (roots.length === 0) {
      steps.push("✗ 没有已授权的工作区");
      return stop(steps, "先在工作区打开一个目录，或手动填一个授权根内的路径");
    }
    path = roots[0].path + "/README.md";
  }

  // 2. 读原文（只读能力：拿不到任何写入口）。
  const read = await attempt(steps, "读文件", () => greywork.call("workspace.read", { op: "read", path }));
  if (!read.ok) return stop(steps, "读取失败：" + reasonOf(read.error));
  const file = read.value || {};
  const excerpt = excerptOf(file.data);
  if (!excerpt) return stop(steps, "文件是空的，没有可摘要的内容");

  // 3. 模型摘要：只传 prompt / system，模型由 manifest 白名单收敛。
  const prompt = ("请把下面这份 " + (file.name || path) + " 压缩成三行以内的中文要点，不要开场白：\n\n" + excerpt).slice(
    0,
    EXCERPT_CHARS + 200,
  );
  const chat = await attempt(steps, "模型摘要", () =>
    greywork.call("llm.chat", {
      prompt,
      system: "你是技术文档编辑：只输出要点本身，三行以内，不要解释、不要客套。",
    }),
  );
  if (!chat.ok) return stop(steps, "摘要失败：" + reasonOf(chat.error));
  const summary = String((chat.value && chat.value.text) || "")
    .trim()
    .slice(0, SUMMARY_CHARS);
  if (!summary) return stop(steps, "模型返回了空内容，换个模型或缩短原文再试");

  // 4. 发布产物：走既有 deliverArtifact，查看器会自动开 tab。
  const published = await attempt(steps, "发布产物", () =>
    greywork.call("artifacts.publish", {
      name: (file.name || "README") + "-速览",
      format: "md",
      data: briefMarkdown(file.name || path, summary, excerpt),
    }),
  );
  if (!published.ok) return stop(steps, "发布失败：" + reasonOf(published.error));

  // 5. 复制摘要：这一步失败不影响已发布的产物，只在状态里说清楚。
  const copied = await attempt(steps, "复制摘要", () => greywork.call("clipboard", { op: "write", text: summary }));

  return {
    path,
    summary,
    artifact: String((published.value && published.value.path) || "").slice(0, 512),
    steps: steps.join(" · ").slice(0, STEPS_CHARS),
    status: (copied.ok ? "四步全通：摘要已发布并在剪贴板" : "摘要已发布，复制失败：" + reasonOf(copied.error)).slice(0, 120),
  };
});

greywork.registerAction("copy", async (state) => {
  const text = typeof state.summary === "string" ? state.summary.trim() : "";
  if (!text) return { status: "还没有摘要，先跑一次「生成速览」" };
  try {
    await greywork.call("clipboard", { op: "write", text });
    return { status: ("已复制 " + text.length + " 字").slice(0, 120) };
  } catch (error) {
    return { status: ("复制被拒：" + reasonOf(error)).slice(0, 120) };
  }
});
