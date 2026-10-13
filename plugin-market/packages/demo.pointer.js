// 渲染指针事件演示插件（plugin-market/packages/demo.pointer.js，已就绪、未发布）。
//
// 契约（v1）：
//   - manifest.runtime.render.pointer=true 时，宿主才把画布指针事件派发给 registerPointer；
//   - 事件 shape：{ type: "down"|"move"|"up"|"cancel"|"leave", x, y, nx, ny, buttons, pointerId }；
//     x/y 已按画布坐标裁剪（0..width / 0..height），nx/ny 为 [0,1] 归一化坐标；
//   - handler 返回状态补丁（与动作同语义，primitive 白名单 isPatch 校验），宿主并入同一份
//     渲染状态 —— 下一帧通过 draw 读到更新；worker 侧无 DOM、无定时器。
//
// 发布三步（与 demo.fetch 同流程，见 plugin-market/README.md）：
//   1. 把 demo.pointer.json / demo.pointer.js 推送到 plugin-market 所在仓库（可先发 PR）；
//   2. `sha256sum packages/demo.pointer.json`，把 runtime.entry 钉到推送后的提交 SHA，
//      并把 hash 填进 runtime.sha256（entry 必须 pin commit，不能是分支）；
//   3. registry.json 增加条目 → `python3 sign_registry.py --verify`
//      → `cd apps/desktop/src-tauri && cargo test plugin_market`。

const CANVAS_W = 220;
const CANVAS_H = 160;

function num(state, key, fallback) {
  return typeof state[key] === "number" && Number.isFinite(state[key]) ? state[key] : fallback;
}

function markerNote(state) {
  const x = Math.round(num(state, "x", CANVAS_W / 2));
  const y = Math.round(num(state, "y", CANVAS_H / 2));
  return `(${x}, ${y})`;
}

// 指针处理器：把每次交互落点写进状态；down 记一次点击。
greywork.registerPointer((event, state) => {
  const patch = { last_event: event.type, nx: event.nx, ny: event.ny };
  if (event.type !== "leave") {
    patch.x = Math.round(event.x);
    patch.y = Math.round(event.y);
  }
  if (event.type === "down") {
    patch.clicks = num(state, "clicks", 0) + 1;
  }
  patch.note = markerNote({ ...state, ...patch });
  return patch;
});

// 渲染：十字准星 + 落点圆环 + 计数；坐标/数量全部落在指令白名单内。
greywork.registerAction("draw", (state) => {
  const x = Math.round(num(state, "x", CANVAS_W / 2));
  const y = Math.round(num(state, "y", CANVAS_H / 2));
  const clicks = Math.round(num(state, "clicks", 0));
  const active = state.last_event === "down";
  return [
    { kind: "rect", x: 0, y: 0, w: CANVAS_W, h: CANVAS_H, fill: "#0f1720" },
    { kind: "rect", x: x - 1, y: 0, w: 2, h: CANVAS_H, fill: "#243244", opacity: 0.9 },
    { kind: "rect", x: 0, y: y - 1, w: CANVAS_W, h: 2, fill: "#243244", opacity: 0.9 },
    { kind: "circle", cx: x, cy: y, r: active ? 12 : 8, fill: "#7bd88f", opacity: 0.9 },
    { kind: "circle", cx: x, cy: y, r: 18, fill: "none", stroke: "#7bd88f", strokeWidth: 1, opacity: 0.5 },
    { kind: "text", x: 8, y: 16, text: `clicks: ${clicks}`, fontSize: 12, fill: "#cbd5e1" },
  ];
});
