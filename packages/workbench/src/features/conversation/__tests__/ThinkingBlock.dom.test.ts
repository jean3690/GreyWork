// 思考段计时：流式中秒表实时跳动（useNow 驱动），结束后冻结为静态读数。
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ThinkingBlock from "@/features/conversation/ThinkingBlock.vue";
import { i18n } from "@/i18n";
import type { ThinkingSegment } from "@/types";

const T = 1_700_000_000_000;

function segment(overrides: Partial<ThinkingSegment> = {}): ThinkingSegment {
  return { kind: "thinking", id: "s1", text: "推理中", startedAt: T, endedAt: T, ...overrides };
}

function mountBlock(seg: ThinkingSegment, live = false) {
  return mount(ThinkingBlock, { props: { segment: seg, live }, global: { plugins: [i18n] } });
}

afterEach(() => vi.useRealTimers());

describe("ThinkingBlock · 计时", () => {
  it("结束态：显示该段静态耗时（endedAt - startedAt）", () => {
    const wrapper = mountBlock(segment({ endedAt: T + 4200 }));
    expect(wrapper.get('[data-testid="thinking-duration"]').text()).toBe("4.2s");
  });

  it("流式中：秒表实时跳动，停流后读数冻结", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T + 1500);
    const wrapper = mountBlock(segment(), true);
    expect(wrapper.get('[data-testid="thinking-duration"]').text()).toBe("1.5s");

    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.get('[data-testid="thinking-duration"]').text()).toBe("2.5s");

    // 停流：切回静态读数，此后时间再走也不变
    await wrapper.setProps({ live: false, segment: segment({ endedAt: T + 2500 }) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.get('[data-testid="thinking-duration"]').text()).toBe("2.5s");
  });
});
