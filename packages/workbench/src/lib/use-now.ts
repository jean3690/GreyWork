/**
 * 秒级 now（epoch ms）ticker：仅在 active 期间跑 interval。
 *
 * 流式计时（思考段已用时、飞行中工具行耗时、工具批次总跨度）都需要一个会自己走的
 * 「当前时刻」来把 startedAt 折算成实时读数。直接在每个组件里 setInterval 会重复
 * 三遍挂载/清理逻辑，且容易漏掉 unmount 清理（happy-dom 下泄漏的 interval 会让
 * 后续用例互相干扰）。
 *
 * active 为 false 时彻底停表：不流式的消息没有任何实时读数需求，没有必要每秒
 * 触发一次全消息流的重渲染。
 */
import { onScopeDispose, onUnmounted, ref, watch, type Ref } from "vue";

export function useNow(active: Ref<boolean> | (() => boolean), intervalMs = 1000): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  function stop(): void {
    if (timer == null) return;
    clearInterval(timer);
    timer = null;
  }

  function start(): void {
    if (timer != null) return;
    now.value = Date.now();
    timer = setInterval(() => (now.value = Date.now()), intervalMs);
  }

  watch(active, (on) => (on ? start() : stop()), { immediate: true });

  const dispose = (): void => stop();
  // 两种宿主都要兜住：组件 setup 里走 onUnmounted；effectScope（如 store 内使用）
  // 里只有 onScopeDispose 会被触发。
  onUnmounted(dispose);
  onScopeDispose(dispose);

  return now;
}
