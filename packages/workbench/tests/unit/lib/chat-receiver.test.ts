/**
 * 接收方计数的契约。
 *
 * 这是防「划词点了没反应」的闸门，所以三条边界都要守：多个接收方按计数、
 * 重复解绑只减一次、减不穿零。任何一条错了，工具条就会在错误的路由下显示可用。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { chatReceiverAvailable, chatReceiverCount, registerChatReceiver, resetChatReceiversForTest } from "@/lib/chat-receiver";

beforeEach(() => {
  resetChatReceiversForTest();
});

describe("chatReceiver", () => {
  it("没有视图注册时不可用", () => {
    expect(chatReceiverCount.value).toBe(0);
    expect(chatReceiverAvailable.value).toBe(false);
  });

  it("注册后可用，解绑后回到不可用", () => {
    const unregister = registerChatReceiver();
    expect(chatReceiverCount.value).toBe(1);
    expect(chatReceiverAvailable.value).toBe(true);

    unregister();
    expect(chatReceiverCount.value).toBe(0);
    expect(chatReceiverAvailable.value).toBe(false);
  });

  it("计数而非布尔：两个视图短暂共存时仍然可用（路由切换的中间态）", () => {
    const first = registerChatReceiver();
    const second = registerChatReceiver();
    expect(chatReceiverCount.value).toBe(2);

    // 旧视图先卸载，新视图还在 —— 此时必须仍然可用，否则工具条会闪一下禁用。
    first();
    expect(chatReceiverAvailable.value).toBe(true);
    second();
    expect(chatReceiverAvailable.value).toBe(false);
  });

  it("重复解绑只减一次（done 闩）：卸载路径不止一条", () => {
    const unregister = registerChatReceiver();
    unregister();
    unregister();
    unregister();
    expect(chatReceiverCount.value).toBe(0);
  });

  it("重复解绑不会把别的接收方一起减掉", () => {
    const stale = registerChatReceiver();
    const live = registerChatReceiver();
    stale();
    stale(); // 多余的解绑必须无效，否则会误伤 live
    expect(chatReceiverCount.value).toBe(1);
    expect(chatReceiverAvailable.value).toBe(true);
    live();
    expect(chatReceiverCount.value).toBe(0);
  });
});
