/** localStorage JSON 持久化小工具：统一 JSON.parse + try/catch + 类型校验样板。 */

export interface JsonStorage<T> {
  /** 读取并校验；无值 / 损坏 / 校验失败返回 null。 */
  read(): T | null;
  /** 序列化写入。 */
  write(value: T): void;
}

/** 兼容浏览器 window.localStorage 与 node 测试注入的 globalThis.localStorage。 */
function getStorage(): Storage | null {
  if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") return window.localStorage;
  if (typeof globalThis !== "undefined") {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage) return storage;
  }
  return null;
}

/**
 * 创建以 localStorage 为后端的 JSON 存储。
 * validate 为类型守卫：解析结果不满足即视为损坏（返回 null），
 * 避免各调用方各自手写 try/catch 与字段校验。
 */
export function createJsonStorage<T>(key: string, validate: (value: unknown) => value is T): JsonStorage<T> {
  return {
    read() {
      const storage = getStorage();
      if (!storage) return null;
      try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return validate(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    write(value) {
      const storage = getStorage();
      if (!storage) return;
      storage.setItem(key, JSON.stringify(value));
    },
  };
}
