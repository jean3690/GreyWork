import { computed, readonly, ref } from "vue";

/**
 * 「当前有没有对话输入框能接收注入内容」。
 *
 * **为什么是计数器而不是布尔**：路由切换时新旧视图会短暂同时挂载，布尔会在那一刻翻成
 * false，工具条跟着闪一下、甚至让用户以为功能不可用。
 *
 * 模块级单例（与 `sheet-draft.ts` 同一路数），但以响应式形式暴露 —— 工具条要随路由
 * 变化自动更新禁用态，所以不能只是一个普通变量。
 *
 * **这是防「静默丢弃」的闸门**：预览面板在团队/定时/助手等路由下依然挂载，而附件桥只
 * 存在于对话页与新建页。没有这道闸门，用户在那里划词点「加入上下文」会什么都不发生。
 */
const count = ref(0);

/** 当前接收方数量（诊断与测试用）。 */
export const chatReceiverCount = readonly(count);

/** 是否有视图能接收注入。工具条的禁用态读它。 */
export const chatReceiverAvailable = computed(() => count.value > 0);

/**
 * 在挂载了对话输入框的视图里调用；返回解绑函数（配合 `onUnmounted`）。
 *
 * `done` 闩让重复解绑安全：组件卸载路径不止一条，少减一次会让计数永久偏高，
 * 于是工具条在任何页面都显示可用 —— 又回到静默丢弃。
 */
export function registerChatReceiver(): () => void {
  count.value += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    count.value = Math.max(0, count.value - 1);
  };
}

/** 仅测试用：清空计数。模块级单例会跨用例泄漏。 */
export function resetChatReceiversForTest(): void {
  count.value = 0;
}
