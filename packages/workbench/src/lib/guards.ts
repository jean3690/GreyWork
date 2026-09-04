/**
 * 类型守卫：workbench 包唯一一份 JSON 负载收窄入口。
 *
 * ACP 宿主事件、持久化会话档、插件清单都是 `unknown` 进来的，按字段读之前必须先确认形状。
 * 只放守卫，不放业务判断——避免每个消费点各写一份 `typeof x === "object"`。
 */

/** 普通对象（排除 null 与数组）；字段仍是 unknown，取用前各自 typeof。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
