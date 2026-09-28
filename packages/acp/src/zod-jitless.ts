import { z } from "zod";

/**
 * 关掉 zod v4 的 JIT 校验器编译（`new Function`）。
 *
 * **必须在 `@agentclientprotocol/sdk` 之前求值** —— SDK 在模块初始化期就会构造 schema，
 * 而构造本身就会跑一次「能不能用 `new Function`」的探测（zod v4 `core/util.js` 里那条
 * `try { new Function("") }`）。探测在 try/catch 里，功能上只是退化成解释执行，但 CSP
 * 会照实报一条 `script-src` 违规：桌面壳与自托管服务端的策略都不含 `'unsafe-eval'`，
 * 于是控制台与报表里永远挂着一条假警报，任何「零违规」的验收都会红。
 *
 * 因此本文件是**副作用模块**，由 client.ts 的第一个 import 引入（ES 模块按 import 出现
 * 顺序求值），保证 config 早于 SDK 的 schema 构造。zod 自己也留了这个开关：
 * v4 `core/util.js`「Skip the probe under `jitless`」。
 *
 * 校验行为与结果完全不变，只是不再编译。
 */
z.config({ jitless: true });
