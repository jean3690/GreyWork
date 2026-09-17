/**
 * dispatchIntent：唯一分流点。四条路径都要锁住 ——
 * ACP（普通 / 计划门）、非 ACP 编排命中、非 ACP 本地管线。
 * 尤其「计划门只在显式打开时生效」「编排只在允许时参与判定」这两个开关，
 * 是三个调用入口行为差异的全部来源。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";
import { useRunsStore } from "@/stores/runs";
import { useSettingsStore } from "@/stores/settings";
import { dispatchIntent } from "@/lib/dispatch-intent";
import type { Attachment } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@greywork/acp", () => ({
  createAcpClient: () => ({ isAvailable: () => true, onEvent: () => Promise.resolve(() => undefined) }) as never,
  desktopHomeDir: () => Promise.resolve("/home/test"),
}));

const FILE: Attachment = { id: "a1", kind: "text", name: "notes.md", mime: "text/markdown", size: 10, path: "/tmp/notes.md" };

function seed() {
  setActivePinia(createPinia());
  const agent = useAgentStore();
  const chat = useChatStore();
  const runs = useRunsStore();
  return {
    agent,
    chat,
    runs,
    dispatchToAcp: vi.spyOn(agent, "dispatchToAcp").mockResolvedValue(undefined),
    beginAcpPlan: vi.spyOn(agent, "beginAcpPlan").mockImplementation(() => undefined),
    submitText: vi.spyOn(chat, "submitText").mockReturnValue(null),
    maybeOrchestrate: vi.spyOn(runs, "maybeOrchestrate").mockReturnValue(false),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("dispatchIntent · ACP 路径", () => {
  it("默认直接派发给 ACP agent", async () => {
    const s = seed();
    s.agent.routeToAcp = true;
    await dispatchIntent("改一下接口", [FILE]);
    expect(s.dispatchToAcp).toHaveBeenCalledWith("改一下接口", [FILE]);
    expect(s.submitText).not.toHaveBeenCalled();
  });

  it("开了计划门且 planMode 打开：挂计划卡，不直接派发", async () => {
    const s = seed();
    s.agent.routeToAcp = true;
    useSettingsStore().planMode = true;
    await dispatchIntent("改一下接口", [], { planGate: true });
    expect(s.beginAcpPlan).toHaveBeenCalledWith("改一下接口", []);
    expect(s.dispatchToAcp).not.toHaveBeenCalled();
  });

  it("开了计划门但 planMode 关着：照常派发", async () => {
    const s = seed();
    s.agent.routeToAcp = true;
    useSettingsStore().planMode = false;
    await dispatchIntent("改一下接口", [], { planGate: true });
    expect(s.dispatchToAcp).toHaveBeenCalledWith("改一下接口", []);
    expect(s.beginAcpPlan).not.toHaveBeenCalled();
  });

  it("没开计划门的入口（引导页 / 提问卡）即使 planMode 开着也不挂卡", async () => {
    const s = seed();
    s.agent.routeToAcp = true;
    useSettingsStore().planMode = true;
    await dispatchIntent("继续", []);
    expect(s.beginAcpPlan).not.toHaveBeenCalled();
    expect(s.dispatchToAcp).toHaveBeenCalledWith("继续", []);
  });
});

describe("dispatchIntent · 本地管线", () => {
  it("默认交给 chat.submitText", async () => {
    const s = seed();
    s.agent.routeToAcp = false;
    await dispatchIntent("写个周报", [FILE]);
    expect(s.submitText).toHaveBeenCalledWith("写个周报", [FILE]);
    expect(s.maybeOrchestrate).not.toHaveBeenCalled();
  });

  it("允许编排且命中：交给 planner，不进本会话消息流", async () => {
    const s = seed();
    s.agent.routeToAcp = false;
    s.maybeOrchestrate.mockReturnValue(true);
    await dispatchIntent("自动执行部署", [], { allowOrchestrate: true });
    expect(s.maybeOrchestrate).toHaveBeenCalledWith("自动执行部署");
    expect(s.submitText).not.toHaveBeenCalled();
  });

  it("允许编排但带附件：跳过编排（planner 只吃纯文本）", async () => {
    const s = seed();
    s.agent.routeToAcp = false;
    s.maybeOrchestrate.mockReturnValue(true);
    await dispatchIntent("自动执行部署", [FILE], { allowOrchestrate: true });
    expect(s.maybeOrchestrate).not.toHaveBeenCalled();
    expect(s.submitText).toHaveBeenCalledWith("自动执行部署", [FILE]);
  });
});
