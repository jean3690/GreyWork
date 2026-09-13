// 桌面宠物猫：状态机跑在隔离 Worker 里，宿主只收到受校验的状态补丁。
// 衰减模型与设计说明见 demo.pet.json 的 page.body。
//
// 渲染：registerAction("draw") 返回宿主白名单 SVG 指令集（render-commands.ts），
// 宿主按 fps 轮询绘制 —— worker 无 DOM/无定时器，动画相位由宿主时钟驱动。

const TICK_MS = 60_000; // 一分钟一个衰减 tick
const MAX_OFFLINE_MS = 12 * 60 * 60 * 1000; // 离线衰减封顶 12h —— 回来最差也是可救状态
const DECAY_PER_TICK = { satiety: 0.4, mood: 0.15, energy: 0.1 };
const STARVING_MOOD_MULTIPLIER = 3; // 饿到 0 后心情三倍速掉

const FEED_GAIN = 30;
const PET_MOOD_GAIN = 8;
const REST_GAIN = 40;

const clamp = (value) => Math.min(100, Math.max(0, value));

function num(state, key) {
  const value = state[key];
  return typeof value === "number" ? value : 0;
}

/** 按真实时间结算衰减；返回新 state（纯计算）。 */
function settle(state, now) {
  const lasttick = num(state, "lasttick") || now;
  const elapsed = Math.min(Math.max(now - lasttick, 0), MAX_OFFLINE_MS);
  const ticks = elapsed / TICK_MS;
  const satiety = clamp(num(state, "satiety") - DECAY_PER_TICK.satiety * ticks);
  const starving = satiety <= 0;
  const mood = clamp(num(state, "mood") - DECAY_PER_TICK.mood * (starving ? STARVING_MOOD_MULTIPLIER : 1) * ticks);
  const energy = clamp(num(state, "energy") - DECAY_PER_TICK.energy * ticks);
  return { ...state, satiety, mood, energy, lasttick: now };
}

/** 表情派生：睡 > 饿 > 难过 > 开心 > 平静。 */
function face(state) {
  if (state.energy < 15) return "😴";
  if (state.satiety < 25) return "😾";
  if (state.mood < 25) return "😿";
  if (state.mood > 70 && state.satiety > 50) return "😸";
  return "😺";
}

function note(state) {
  if (state.energy < 15) return "困得睁不开眼了……";
  if (state.satiety < 25) return "碗是空的，它在盯着你。";
  if (state.mood < 25) return "心情不太好，需要撸一撸。";
  if (state.mood > 70 && state.satiety > 50) return "尾巴翘得很高。";
  return "在窗边晒太阳。";
}

function finalize(state) {
  return { ...state, face: face(state), note: note(state) };
}

// ---------------------------------------------------------------------------
// 渲染：draw handler 返回宿主白名单指令集（120×120 画布）。
// 动画：呼吸（scale 随时间摆动）、尾巴（rotate 摆动）、眨眼（每 4s 一闭）、表情差分。
// ---------------------------------------------------------------------------

/** 呼吸相位：0..2π 随时间循环（宿主时钟），决定身体 scale。 */
function phase(now) {
  return ((now % 3000) / 3000) * Math.PI * 2;
}

/** 眨眼相位：每 4s 闭 300ms（scaleY 压扁为线）。 */
function blinkScale(now) {
  const t = now % 4000;
  return t < 3700 ? 1 : t < 3850 ? 0.15 : t < 4000 ? 1 : 1;
}

const FACE_COLORS = {
  "😸": { body: "#f7c873", blush: true, mouth: "M46 62 Q52 68 58 62", eyes: "open" },
  "😺": { body: "#f7c873", blush: false, mouth: "M46 64 L58 64", eyes: "open" },
  "😾": { body: "#e8a35c", blush: false, mouth: "M46 66 Q52 60 58 66", eyes: "open" },
  "😿": { body: "#a8b8d0", blush: false, mouth: "M46 66 Q52 60 58 66", eyes: "open" },
  "😴": { body: "#c9d6e8", blush: false, mouth: "M46 62 Q52 66 58 62", eyes: "closed" },
};

function renderFrame(state, now) {
  const currentFace = face(state);
  const faceSpec = FACE_COLORS[currentFace];
  const breathe = 1 + 0.03 * Math.sin(phase(now));
  const tailAngle = 12 * Math.sin(phase(now) * 0.8);
  const blink = faceSpec.eyes === "closed" ? 0.1 : blinkScale(now);

  const commands = [
    // 呼吸：整体 group scale。
    {
      kind: "group",
      scale: breathe,
      translate: [60, 60],
      children: [
        // 尾巴（旋转摆动）。
        { kind: "path", d: "M0 14 Q 20 14 24 2", fill: "none", stroke: "#b08450", strokeWidth: 5, opacity: 0.9 },
        {
          kind: "group",
          rotate: tailAngle,
          children: [
            // 身体
            { kind: "ellipse", cx: 0, cy: 18, rx: 30, ry: 22, fill: faceSpec.body },
            // 耳朵
            { kind: "path", d: "M-22 6 L-26 -14 L-6 -4 Z", fill: faceSpec.body },
            { kind: "path", d: "M22 6 L26 -14 L6 -4 Z", fill: faceSpec.body },
            // 内耳
            { kind: "path", d: "M-20 2 L-22 -10 L-12 -3 Z", fill: "#e8a35c", opacity: 0.6 },
            { kind: "path", d: "M20 2 L22 -10 L12 -3 Z", fill: "#e8a35c", opacity: 0.6 },
            // 头
            { kind: "circle", cx: 0, cy: -6, r: 22, fill: faceSpec.body },
          ],
        },
        // 眼睛（独立于尾巴 group）
        ...(blink > 0.5
          ? [
              { kind: "circle", cx: -8, cy: -8, r: 3, fill: "#3d2b1f" },
              { kind: "circle", cx: 8, cy: -8, r: 3, fill: "#3d2b1f" },
            ]
          : [
              { kind: "path", d: "M-11 -8 Q-8 -6 -5 -8", fill: "none", stroke: "#3d2b1f", strokeWidth: 1.6 },
              { kind: "path", d: "M5 -8 Q8 -6 11 -8", fill: "none", stroke: "#3d2b1f", strokeWidth: 1.6 },
            ]),
        // 嘴
        { kind: "path", d: faceSpec.mouth, fill: "none", stroke: "#3d2b1f", strokeWidth: 1.8 },
        // 腮红
        ...(faceSpec.blush
          ? [
              { kind: "ellipse", cx: -14, cy: 0, rx: 4, ry: 2.4, fill: "#e8705a", opacity: 0.5 },
              { kind: "ellipse", cx: 14, cy: 0, rx: 4, ry: 2.4, fill: "#e8705a", opacity: 0.5 },
            ]
          : []),
      ],
    },
  ];
  return commands;
}

greywork.registerAction("draw", (state) => renderFrame(state, Date.now()));

greywork.registerAction("settle", (state) => {
  return finalize(settle(state, Date.now()));
});

greywork.registerAction("pet", (state) => {
  const next = settle(state, Date.now());
  return finalize({
    ...next,
    mood: clamp(next.mood + PET_MOOD_GAIN),
    petcount: num(next, "petcount") + 1,
  });
});

greywork.registerAction("feed", (state) => {
  const next = settle(state, Date.now());
  return finalize({ ...next, satiety: clamp(next.satiety + FEED_GAIN) });
});

greywork.registerAction("rest", (state) => {
  const next = settle(state, Date.now());
  return finalize({ ...next, energy: clamp(next.energy + REST_GAIN) });
});
