/**
 * 圆角守卫：拦住新写死的 px 圆角工具类。
 *
 * 外观设置里的「无圆角 / 小圆角 / 大圆角」靠一个总旋钮 `--gw-radius-scale` 驱动
 * （见 theme/base.css 的说明），所有装饰性圆角都必须写成
 * `rounded-[calc(<N>px*var(--gw-radius-scale))]` 才能跟着它变。
 *
 * 写死成 `rounded-[8px]` 的话**不会报错、也不会有人发现** —— 它只是在那一个控件上
 * 悄悄不跟随设置。这类「静默失效」正是要靠一道守卫兜住的：新增圆角时把数字抄进
 * calc 里就行，而语义性的 `rounded-full`（药丸/头像）/ `rounded-none` 本来就不该跟随，
 * 不在拦截范围。
 *
 * 由 `pnpm lint` 调用（所以 CI 的 lint job 与 .husky/pre-push 都会跑到）。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** 拦截范围：源码目录下的 .vue/.ts。coverage/dist 等产物目录不扫。 */
const ROOTS = ["packages", "apps"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "target", "src-tauri"]);
const OFFENDER = /rounded(-[a-z]+)?-\[(?:\d+)px\]/g;

const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(p);
      continue;
    }
    if (!/\.(vue|ts)$/.test(entry.name)) continue;
    const lines = readFileSync(p, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(OFFENDER)) {
        offenders.push(`${p}:${index + 1}  ${match[0]}`);
      }
    });
  }
}

for (const root of ROOTS) walk(root);

if (offenders.length > 0) {
  console.error(
    `[radius-guard] ${offenders.length} 处写死的 px 圆角不会跟随「外观 → 圆角」设置：\n` +
      offenders.map((line) => `  ${line}`).join("\n") +
      `\n\n改成 rounded-[calc(<N>px*var(--gw-radius-scale))]。语义性的药丸 / 直角用 rounded-full / rounded-none，不受本守卫限制。`,
  );
  process.exit(1);
}
