/**
 * 单调递增的短 id 工厂。
 *
 * 此前 8 处调用方各写一份 id 生成器，风格三分（模块级 seq 计数器 /
 * `Math.random().toString(36)` / `Date.now()`），导致同一会话内不同实体的
 * id 既不可比也不可排序，随机那两份还存在碰撞可能。统一为按前缀独立计数的
 * 工厂：同前缀严格递增，跨前缀互不干扰。
 */
export interface IdFactory {
  (): string;
  /** 重置计数（测试用；生产代码不应调用）。 */
  reset(): void;
}

/** 创建 `${prefix}-${n}` 形式的 id 工厂，n 从 1 起严格递增。 */
export function createIdFactory(prefix: string): IdFactory {
  let seq = 0;
  const next = (): string => {
    seq += 1;
    return `${prefix}-${seq}`;
  };
  next.reset = (): void => {
    seq = 0;
  };
  return next;
}
