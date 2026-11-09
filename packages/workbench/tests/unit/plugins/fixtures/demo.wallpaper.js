// 动态壁纸：四套主题（星空 / 极光 / 落日 / 雨夜）跑在隔离 Worker 里，
// 宿主按 fps 轮询 draw 拿 SVG 指令集（render-commands.ts 白名单）。
//
// 设计要点：
//   - worker 无 DOM、无定时器：动画相位由 Date.now() 驱动，暂停时相位冻结在 state.phase；
//   - 没有渐变指令 —— 天空用色带（rect）叠出来，极光用带描边的正弦 path，都在指令白名单内；
//   - 一帧的指令数远低于上限（256），坐标/尺寸都落在 2×512 的有界范围内；
//   - 点击画布（render.pointer）循环切换主题，与「下一套主题」动作同一条路径。

const W = 480;
const H = 300;
const THEMES = ["starfield", "aurora", "sunset", "rain"];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value) => Math.round(value);
const round2 = (value) => Math.round(value * 100) / 100;

function num(state, key, fallback) {
  const value = state[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function themeOf(state) {
  const theme = typeof state.theme === "string" ? state.theme : "";
  return THEMES.includes(theme) ? theme : THEMES[0];
}

function nextTheme(theme) {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}

/** 播放速度（0.2–3 倍），用户可在页面里调。 */
function speedOf(state) {
  return clamp(num(state, "speed", 1), 0.2, 3);
}

/**
 * 动画相位（秒）。暂停时冻结在 state.phase；播放时按「相位 + 经过秒数 × 速度」推进。
 * phase_at 为 0（首次运行）时按当前时刻起算，避免相位一下子跳到几万秒。
 */
function phaseOf(state, now) {
  const base = num(state, "phase", 0);
  if (state.paused === true) return base;
  const at = num(state, "phase_at", 0) || now;
  return base + ((now - at) / 1000) * speedOf(state);
}

/** 确定性伪随机（同一 index 每帧一致，星星不会闪烁乱跳）。 */
function hash(seed) {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function background(fill) {
  return { kind: "rect", x: 0, y: 0, w: W, h: H, fill };
}

// ---------------------------------------------------------------------------
// 主题：星空
// ---------------------------------------------------------------------------

function starfield(t) {
  const commands = [background("#070b18")];
  // 月亮 + 光晕
  commands.push({ kind: "circle", cx: W - 72, cy: 64, r: 26, fill: "#f6f1d5", opacity: 0.95 });
  commands.push({ kind: "circle", cx: W - 72, cy: 64, r: 36, fill: "none", stroke: "#f6f1d5", strokeWidth: 1, opacity: 0.22 });
  // 星星：按深度视差下落 + 独立闪烁
  for (let index = 0; index < 54; index += 1) {
    const seed = index + 1;
    const depth = 0.4 + hash(seed + 91) * 0.9;
    const x = hash(seed) * W;
    const y = (hash(seed + 17) * H + t * 6 * depth) % H;
    const twinkle = 0.45 + 0.45 * Math.sin(t * 2 + seed);
    commands.push({
      kind: "circle",
      cx: round(x),
      cy: round(y),
      r: round2(0.5 + depth * 1.1),
      fill: "#dbe7ff",
      opacity: round2(clamp(0.3 + 0.5 * twinkle, 0.05, 0.95)),
    });
  }
  // 流星：每 9 秒一次，1.1 秒内划过
  const cycle = t % 9;
  if (cycle < 1.1) {
    const progress = cycle / 1.1;
    const x = 60 + progress * (W - 160);
    const y = 40 + progress * 110;
    commands.push({
      kind: "path",
      d: `M${round(x)} ${round(y)} L ${round(x - 46)} ${round(y - 26)}`,
      stroke: "#ffffff",
      strokeWidth: 1.6,
      opacity: round2(0.8 * (1 - progress)),
    });
  }
  return commands;
}

// ---------------------------------------------------------------------------
// 主题：极光
// ---------------------------------------------------------------------------

function wavePath(band, t) {
  const points = 13;
  const step = W / (points - 1);
  let d = "";
  for (let index = 0; index < points; index += 1) {
    const x = index * step;
    const y =
      band.y + Math.sin(x * band.freq + t * 0.9 + band.phase) * band.amp + Math.sin(x * band.freq * 2.3 + t * 1.7) * band.amp * 0.35;
    d += `${index === 0 ? "M" : "L"}${round(x)} ${round(y)} `;
  }
  return d.trim();
}

function aurora(t) {
  const commands = [background("#04060f")];
  for (let index = 0; index < 16; index += 1) {
    const seed = index + 200;
    commands.push({
      kind: "circle",
      cx: round(hash(seed) * W),
      cy: round(hash(seed + 7) * H * 0.6),
      r: round2(0.4 + hash(seed + 3) * 0.9),
      fill: "#cfe3ff",
      opacity: round2(0.2 + 0.5 * (0.5 + 0.5 * Math.sin(t * 1.5 + seed))),
    });
  }
  const bands = [
    { y: H * 0.42, amp: 26, freq: 0.012, phase: 0, color: "#4ade80", width: 22, opacity: 0.22 },
    { y: H * 0.5, amp: 34, freq: 0.009, phase: 1.7, color: "#22d3ee", width: 28, opacity: 0.18 },
    { y: H * 0.58, amp: 22, freq: 0.014, phase: 3.1, color: "#a78bfa", width: 18, opacity: 0.2 },
  ];
  for (const band of bands) {
    commands.push({
      kind: "path",
      d: wavePath(band, t),
      fill: "none",
      stroke: band.color,
      strokeWidth: band.width,
      opacity: band.opacity,
    });
  }
  commands.push({ kind: "rect", x: 0, y: H - 24, w: W, h: 24, fill: "#070a16" });
  return commands;
}

// ---------------------------------------------------------------------------
// 主题：落日
// ---------------------------------------------------------------------------

/** 天空色带取色：深紫 → 玫红 → 橙 → 金（没有渐变指令，用 12 条色带模拟）。 */
function skyColor(ratio) {
  const stops = [
    [43, 16, 85],
    [94, 30, 110],
    [190, 60, 90],
    [255, 126, 95],
    [254, 180, 123],
  ];
  const scaled = ratio * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const from = stops[index];
  const to = stops[index + 1];
  const channel = (offset) =>
    Math.round(from[offset] + (to[offset] - from[offset]) * local)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function sunset(t) {
  const horizon = H * 0.62;
  const bands = 12;
  const commands = [];
  for (let index = 0; index < bands; index += 1) {
    commands.push({
      kind: "rect",
      x: 0,
      y: round((index * horizon) / bands),
      w: W,
      h: Math.ceil(horizon / bands) + 1,
      fill: skyColor(index / (bands - 1)),
    });
  }
  // 太阳 + 两圈光晕
  const sunX = W * 0.66;
  const sunY = horizon - 26;
  commands.push({ kind: "circle", cx: round(sunX), cy: round(sunY), r: 30, fill: "#ffe9b0" });
  commands.push({
    kind: "circle",
    cx: round(sunX),
    cy: round(sunY),
    r: 42,
    fill: "none",
    stroke: "#ffb86b",
    strokeWidth: 2,
    opacity: 0.35,
  });
  commands.push({
    kind: "circle",
    cx: round(sunX),
    cy: round(sunY),
    r: 56,
    fill: "none",
    stroke: "#ff9a62",
    strokeWidth: 1.5,
    opacity: 0.2,
  });
  // 云：缓慢横移，出画后从左侧回来
  for (let index = 0; index < 5; index += 1) {
    const drift = ((hash(index + 7) * W + t * 4 * (0.5 + hash(index + 3))) % (W + 120)) - 60;
    commands.push({
      kind: "ellipse",
      cx: round(drift),
      cy: round(40 + hash(index + 11) * 80),
      rx: round2(26 + hash(index + 13) * 18),
      ry: round2(6 + hash(index + 17) * 4),
      fill: "#ffd7a8",
      opacity: 0.35,
    });
  }
  // 水面 + 倒影波纹
  commands.push({ kind: "rect", x: 0, y: round(horizon), w: W, h: round(H - horizon), fill: "#2b1c3f" });
  for (let index = 0; index < 9; index += 1) {
    const width = 90 - index * 8;
    commands.push({
      kind: "rect",
      x: round(sunX - width / 2 + Math.sin(t * 1.2 + index) * 6),
      y: round(horizon + 8 + index * 12),
      w: round(width),
      h: 2,
      fill: "#ffcf9a",
      opacity: round2(clamp(0.35 - index * 0.03, 0.05, 0.4)),
    });
  }
  return commands;
}

// ---------------------------------------------------------------------------
// 主题：雨夜
// ---------------------------------------------------------------------------

function rain(t) {
  const commands = [background("#0a1220")];
  // 远处路灯
  for (let index = 0; index < 7; index += 1) {
    commands.push({ kind: "circle", cx: 40 + index * 62, cy: 34, r: 3, fill: "#8fb3ff", opacity: 0.35 });
  }
  // 雨丝：不同速度的下落
  for (let index = 0; index < 46; index += 1) {
    const seed = index + 1;
    const x = (hash(seed) * W + t * 40) % W;
    const fall = 220 * (0.7 + hash(seed + 5));
    const y = ((hash(seed + 31) * H + t * fall) % (H + 30)) - 15;
    commands.push({
      kind: "rect",
      x: round(x),
      y: round(y),
      w: 1,
      h: round(8 + hash(seed + 9) * 10),
      fill: "#9ec5ff",
      opacity: round2(0.25 + hash(seed + 3) * 0.35),
    });
  }
  // 地面涟漪：按相位扩散并淡出
  for (let index = 0; index < 6; index += 1) {
    const seed = index + 41;
    const progress = (t * 0.6 + hash(seed + 2)) % 1;
    commands.push({
      kind: "ellipse",
      cx: round(hash(seed) * W),
      cy: H - 10,
      rx: round2(4 + progress * 14),
      ry: round2(1.5 + progress * 5),
      fill: "none",
      stroke: "#9ec5ff",
      strokeWidth: 1,
      opacity: round2(0.45 * (1 - progress)),
    });
  }
  commands.push({ kind: "rect", x: 0, y: H - 6, w: W, h: 6, fill: "#0d1830" });
  return commands;
}

const RENDERERS = { starfield, aurora, sunset, rain };

/** 右下角时钟：壁纸的「有用」之处，每分钟自动刷新（draw 每帧重算）。 */
function clock(now) {
  const date = new Date(now);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return { kind: "text", x: 16, y: H - 16, text: `${hh}:${mm}`, fontSize: 20, fill: "#ffffff", opacity: 0.7 };
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

greywork.registerAction("draw", (state) => {
  const now = Date.now();
  const frame = RENDERERS[themeOf(state)](phaseOf(state, now));
  frame.push(clock(now));
  return frame;
});

greywork.registerAction("cycle", (state) => {
  const theme = nextTheme(themeOf(state));
  return { theme, note: `已切换到「${theme}」` };
});

greywork.registerAction("toggle", (state) => {
  const now = Date.now();
  if (state.paused === true) {
    return { paused: false, phase_at: now, note: "继续播放" };
  }
  return { paused: true, phase: phaseOf(state, now), phase_at: now, note: "已暂停" };
});

// 点画布（页面 / 悬浮窗）切下一套主题 —— 与「下一套主题」动作同一条路径。
greywork.registerPointer((event, state) => {
  if (event.type !== "down") return;
  const theme = nextTheme(themeOf(state));
  return { theme, note: `已切换到「${theme}」` };
});
