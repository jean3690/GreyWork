// schedule 能力演示插件（plugin-market/packages/demo.schedule.js，已就绪、未发布）。
//
// 能力语义：manifest 用参数化声明声明后台定时
//   { "capability": "schedule", "schedule": { "kind": "interval", "min": 5 } }
// （5–1440 分钟，安装期 Rust 校验形态与边界）。宿主（工作台渲染进程）在插件
// **挂载面**存活期间挂钟：区域每 5 分钟唤醒一次下面的 registerSchedule 处理器；
// 处理器与动作走同一条 invoke 通道，返回的状态补丁全量合并进区域状态。
// 挂载面不在内存时跳过，下次激活补结算一次 —— 离线结算由调度器持久化 nextDue 完成。
//
// 注意：schedule 是**宿主驱动**的能力，worker 不应 `greywork.call("schedule", …)`；
// 要做的只是用 `greywork.registerSchedule(handler)` 注册处理器。"schedule" 是保留
// 处理器名，不能再被 registerAction 占用。
//
// 发布三步（与 demo.kv / demo.fs 同流程，见 plugin-market/README.md）：
//   1. 把 demo.schedule.json / demo.schedule.js 推送到 plugin-market 所在仓库（可先发 PR）；
//   2. `sha256sum packages/demo.schedule.js`，把 runtime.entry 钉到推送后的提交 SHA，
//      并把 hash 填进 runtime.sha256（entry 必须 pin commit，不能是分支）；
//   3. registry.json 增加条目 → `python3 sign_registry.py --verify`
//      → `cargo test -p greywork-host plugin_market`。

/** 后台定时处理器：宿主到点唤醒，巡检次数 +1（与手动动作共用区域状态）。 */
greywork.registerSchedule(async (state) => {
  const count = (typeof state.count === "number" ? state.count : 0) + 1;
  return { count, lastKind: "后台", lastAt: new Date().toLocaleTimeString("zh-CN") };
});

/** 手动「立即巡检」：同一份计数，标注来源为手动，便于与后台触发对照。 */
greywork.registerAction("patrol", async (state) => {
  const count = (typeof state.count === "number" ? state.count : 0) + 1;
  return { count, lastKind: "手动", lastAt: new Date().toLocaleTimeString("zh-CN") };
});

/** 渲染循环：圆点随巡检次数变大，底部一行文字显示次数与最近一次来源。 */
greywork.registerAction("draw", (state) => {
  const count = typeof state.count === "number" ? state.count : 0;
  const kind = typeof state.lastKind === "string" ? state.lastKind : "未巡检";
  const radius = Math.min(12 + count * 2, 44);
  return [
    { kind: "rect", x: 0, y: 0, w: 180, h: 140, rx: 12, fill: "#111827" },
    { kind: "circle", cx: 90, cy: 60, r: radius, fill: "#7bd88f", opacity: 0.85 },
    { kind: "text", x: 90, y: 120, text: `巡检 ${count} 次 · ${kind}`, fontSize: 14, fill: "#e5e7eb" },
  ];
});
