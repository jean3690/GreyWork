/**
 * 有界 LRU 容器：给"按 key 缓存、但 key 空间无界"的场景兜一道内存上限。
 *
 * 动机：本仓多处缓存是"顺手加的"—— 网页正文、Git diff、文件图标。它们都没有上限，
 * 长会话或大仓库下会随访问过的 key 数单调增长，在低内存设备上正是 OOM / 卡顿的来源。
 * 这里把"超过上限就丢最久未用的那个"收敛成一个实现，避免每处各写一遍淘汰逻辑。
 *
 * **真 LRU，不是 FIFO**：`get` 命中也刷新顺序。此前 `state/attachment-library.ts` 的注释
 * 写的是 LRU，实现却是插入序 FIFO —— 结果是最早看过的条目即便一直在用也会被淘汰。
 * 缓存的意义就是留住热点，所以这里按"最近使用"排序。
 *
 * `onEvict` 在任何值离开容器时触发（容量淘汰 / `delete` / `clear`），而不只是容量淘汰：
 * 对持有外部资源的调用方（blob URL 要 `revokeObjectURL`），`clear` 也必须释放干净，
 * 否则"清空缓存"反而成了泄漏源。
 */
export interface BoundedMap<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
  /** 当前条目数（淘汰后不会超过 limit）。 */
  readonly size: number;
}

/**
 * 创建有界 LRU。`limit` 为最大条目数；`onEvict` 可选，用于释放值持有的外部资源。
 *
 * 底层用 `Map` 的插入序当"最近使用序"：命中即 `delete` + 重新 `set` 挪到末尾，
 * 于是首个 key 永远是最久未用的那个。
 */
export function createBoundedMap<K, V>(limit: number, onEvict?: (value: V, key: K) => void): BoundedMap<K, V> {
  const store = new Map<K, V>();

  function drop(key: K): void {
    const value = store.get(key);
    store.delete(key);
    onEvict?.(value as V, key);
  }

  return {
    get(key) {
      if (!store.has(key)) return undefined;
      const value = store.get(key) as V;
      // 命中刷新顺序：删了再插，把它挪到末尾（最近使用）。
      store.delete(key);
      store.set(key, value);
      return value;
    },

    set(key, value) {
      // 覆盖也算一次使用：先删掉旧位，重新插到末尾。
      if (store.has(key)) store.delete(key);
      store.set(key, value);
      while (store.size > limit) {
        const oldest = store.keys().next().value as K | undefined;
        if (oldest === undefined) break;
        drop(oldest);
      }
    },

    has(key) {
      return store.has(key);
    },

    delete(key) {
      if (!store.has(key)) return false;
      drop(key);
      return true;
    },

    clear() {
      // 先清空再逐个回调：`onEvict` 若抛异常，容器本身也已经空了，不会留下半清状态。
      const entries = [...store.entries()];
      store.clear();
      for (const [key, value] of entries) onEvict?.(value, key);
    },

    get size() {
      return store.size;
    },
  };
}
