#!/usr/bin/env node
// 从 CHANGELOG.md 抽取某个版本的正文，供 release.yml 填进 Release 说明。
// 用 node 内置模块实现：三个平台 runner 上无需装依赖即可跑（发布 job 里还没有 pnpm install）。
//
//   node scripts/changelog-section.mjs v0.1.0                      # 打印正文
//   node scripts/changelog-section.mjs 0.1.0 --github-output body  # 写进 $GITHUB_OUTPUT

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const changelogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");
const HEADING = /^##\s+\[?([^\]\s]+)\]?(?:\s|$)/;

function fail(message) {
  console.error(`changelog-section: ${message}`);
  process.exit(1);
}

const [versionArg, ...rest] = process.argv.slice(2);
if (!versionArg) fail("缺少版本号，例如 `node scripts/changelog-section.mjs v0.1.0`");

// 标签名带 `v` 前缀，CHANGELOG 标题不带，两种写法都接受。
const wanted = versionArg.replace(/^v/, "");

const lines = readFileSync(changelogPath, "utf8").split(/\r?\n/);
const headings = lines.flatMap((line, index) => {
  const matched = HEADING.exec(line);
  return matched ? [{ version: matched[1], index }] : [];
});

const start = headings.findIndex((heading) => heading.version === wanted);
if (start === -1) {
  const known = headings.map((heading) => heading.version).join(", ") || "（无）";
  fail(`CHANGELOG.md 里没有版本 ${wanted}；已有版本：${known}`);
}

const body = lines
  .slice(headings[start].index + 1, headings[start + 1]?.index ?? lines.length)
  .join("\n")
  .trim()
  // 文件末尾的链接定义不属于任何一节，别混进 Release 正文。
  .split("\n")
  .reduceRight((kept, line) => (kept.length === 0 && /^\[[^\]]+\]:\s+\S/.test(line) ? kept : [line, ...kept]), [])
  .join("\n")
  .trim();

if (body.length === 0) fail(`版本 ${wanted} 的条目是空的，先补 CHANGELOG 再发版`);

const outputIndex = rest.indexOf("--github-output");
if (outputIndex === -1) {
  process.stdout.write(`${body}\n`);
} else {
  const name = rest[outputIndex + 1];
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!name || rest.length !== outputIndex + 2) fail("--github-output 需要一个参数：输出名");
  if (!outputFile) fail("--github-output 需要 GITHUB_OUTPUT 环境变量（只在 Actions 里有效）");
  appendFileSync(outputFile, `${name}<<CHANGELOG_EOF\n${body}\nCHANGELOG_EOF\n`);
  console.log(`已写入 ${name}（${body.length} 字符）`);
}
