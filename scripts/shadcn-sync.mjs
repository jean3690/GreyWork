#!/usr/bin/env node
/**
 * shadcn-vue 组件的本地化改造（幂等）。
 *
 * 为什么是脚本而不是一次性的 sed：`shadcn add` 每次落盘的都是一模一样的上游代码，
 * 而其中三处与本项目的约定冲突。手工改一遍等于埋一个雷 —— 下个月再加个组件，
 * hover 态就会莫名其妙变成品牌蓝。所以本地化必须可重复执行。
 *
 * 用法：pnpm shadcn:add <组件名...>   （CLI add + 本脚本，别直接调 CLI）
 *      node scripts/shadcn-sync.mjs  （只跑改造，用于修上游漂移）
 *
 * 三条规则：
 *
 *   1. @lucide/vue → lucide-vue-next
 *      v4 注册表从 @lucide/vue 导图标。本项目已有 lucide-vue-next（features/shared 下 3 处在用），
 *      两者同源、图标名一致（含 ChevronDownIcon 这类 *Icon 别名），改导入即可省掉一个重复图标包。
 *
 *   2. -accent / -accent-foreground → -secondary / -secondary-foreground
 *      tokens.css 的 --accent 是 GreyWork 蓝（全仓约 110 处按品牌色在用），
 *      而 shadcn 拿 accent 表达 hover / 选中面 —— 同名不同义。
 *      组件侧让位：hover 面改用 --secondary（= --panel-2），语义正好是「悬浮面」。
 *      详见 theme/shadcn.css 顶部那段注释。
 *
 *   3. 遮罩 bg-black/80 → bg-black/40
 *      项目既有弹窗统一 40%（features/ 下 7 处），上游默认 80%。
 *      共存期两种遮罩并排会很跳，统一到项目现值。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI_DIR = fileURLToPath(new URL("../packages/workbench/src/components/ui", import.meta.url));

/** 数一段文本里某个模式出现几次；replaceAll 的计数辅助。 */
function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

const RULES = [
  {
    id: "lucide-package",
    describe: "@lucide/vue → lucide-vue-next",
    apply(source) {
      const pattern = /"@lucide\/vue"/g;
      return { text: source.replace(pattern, '"lucide-vue-next"'), count: countMatches(source, pattern) };
    },
  },
  {
    id: "accent-to-secondary",
    describe: "-accent(-foreground) → -secondary(-foreground)",
    apply(source) {
      // 先处理长 token，避免 -accent-foreground 被短规则截断。
      const foreground = /-accent-foreground/g;
      const afterForeground = source.replace(foreground, "-secondary-foreground");
      let count = countMatches(source, foreground);
      // 只替换结束于类名 token 边界的 -accent：不碰 var(--accent)、也不碰别的长标识符。
      const bare = /-accent(?=[\s"'`/\]},;])/g;
      count += countMatches(afterForeground, bare);
      return { text: afterForeground.replace(bare, "-secondary"), count };
    },
  },
  {
    id: "overlay-opacity",
    describe: "遮罩 bg-black/80 → bg-black/40",
    apply(source) {
      const pattern = /bg-black\/80/g;
      return { text: source.replace(pattern, "bg-black/40"), count: countMatches(source, pattern) };
    },
  },
  {
    id: "tooltip-skin",
    only: /tooltip\/TooltipContent\.vue$/,
    describe: "TooltipContent 收成项目紧凑规格（popover 底 + line-2 边 + 去箭头）",
    apply(source) {
      let text = source;
      let count = 0;
      /** 每次字面替换成功就记一次；失败说明上游已漂移，靠总数变 0 暴露出来。 */
      const swap = (from, to) => {
        if (!text.includes(from)) return;
        text = text.replace(from, to);
        count += 1;
      };

      // 上游默认是 bg-foreground/text-background 的深色块 + 内置箭头。
      // 项目既有的自制 tooltip 是「紧凑 + popover 底 + line-2 边 + 无箭头」，
      // 且带边框的提示配无边框箭头会留一道缝，所以箭头直接去掉。
      swap("bg-foreground text-background ", "border border-line-2 bg-popover text-foreground shadow-lg ");
      swap("rounded-md px-3 py-1.5 text-xs", "rounded-[5px] px-1.5 py-0.5 text-[10px]");
      if (text.includes("<TooltipArrow")) {
        text = text.replace(/\s*<TooltipArrow[\s\S]*?\/>/, "");
        count += 1;
      }
      swap("TooltipArrow, ", "");

      return { text, count };
    },
  },
];

/** 规则可按文件名收窄：`only` 命中的规则才跑（默认全跑）。 */
function rulesFor(file) {
  return RULES.filter((rule) => !rule.only || rule.only.test(file));
}

/** 递归收集 ui 目录下的 .vue / .ts（index.ts 不含样式，但一起走省得判断）。 */
function collectFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(full);
    return /\.(vue|ts)$/.test(entry.name) ? [full] : [];
  });
}

let files = [];
try {
  files = collectFiles(UI_DIR);
} catch {
  console.error(`[shadcn-sync] 找不到 ${UI_DIR}。先跑 pnpm shadcn:add <组件名>。`);
  process.exit(1);
}

const tally = new Map(RULES.map((rule) => [rule.id, 0]));
const touched = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  let next = source;

  for (const rule of rulesFor(file)) {
    const result = rule.apply(next);
    next = result.text;
    if (result.count > 0) tally.set(rule.id, tally.get(rule.id) + result.count);
  }

  if (next !== source) {
    writeFileSync(file, next);
    touched.push(path.relative(UI_DIR, file));
  }
}

const total = [...tally.values()].reduce((sum, n) => sum + n, 0);

if (total === 0) {
  console.log(`[shadcn-sync] ${files.length} 个文件已符合本地约定，无需改动。`);
} else {
  for (const rule of RULES) {
    const n = tally.get(rule.id);
    if (n > 0) console.log(`[shadcn-sync] ${String(n).padStart(3)} 处  ${rule.describe}`);
  }
  console.log(`[shadcn-sync] 改动了 ${touched.length} 个文件：`);
  for (const name of touched) console.log(`  - ${name}`);
}
