/**
 * 编译期一致性检查（不产生用例，靠 `pnpm typecheck` 失败来报警）。
 *
 * 作者用的类型在 `@greywork/plugin-types`，宿主真正消费的是 `market-types.ts` 的
 * `MarketPluginManifest`，两边都是手写。把整份清单互相赋值太苛刻（作者类型更窄、宿主更宽），
 * 所以只盯三件事：
 *   1. 顶层字段名两边完全一致（漏字段 = 作者写了宿主不认，或反之）；
 *   2. 标量字段类型完全一致；
 *   3. requires 的形状能被宿主接受。
 * 声明式页面里的细节（targets 用的宽/窄联合等）不在此列——那部分由 Rust 安装期校验兜底。
 */
import type { MarketPluginManifest } from "@/plugins/market-types";
import type { PluginManifest } from "@greywork/plugin-types";

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;
type ExpectNever<T extends never> = T;

type MissingInAuthor = Exclude<keyof MarketPluginManifest, keyof PluginManifest>;
type ExtraInAuthor = Exclude<keyof PluginManifest, keyof MarketPluginManifest>;

/** 宿主有、作者类型没有 → 作者会漏写宿主要求的字段。 */
export type NoMissingKeys = ExpectNever<MissingInAuthor>;
/** 作者有、宿主没有 → 作者会写出宿主不认识的字段（安装期被拒或静默忽略）。 */
export type NoExtraKeys = ExpectNever<ExtraInAuthor>;

export type IdMatches = Expect<Equal<PluginManifest["id"], MarketPluginManifest["id"]>>;
export type NameMatches = Expect<Equal<PluginManifest["name"], MarketPluginManifest["name"]>>;
export type VersionMatches = Expect<Equal<PluginManifest["version"], MarketPluginManifest["version"]>>;
export type KindMatches = Expect<Equal<PluginManifest["kind"], MarketPluginManifest["kind"]>>;

/** 作者声明的能力项必须能被宿主直接消费（多出来的参数形态会在这里编译失败）。 */
export type RequiresAccepted = Expect<NonNullable<PluginManifest["requires"]> extends MarketPluginManifest["requires"] ? true : false>;
