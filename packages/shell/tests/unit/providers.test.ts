/**
 * @greywork/shell 供应商注册表的纯函数与预设数据不变量测试。
 *
 * shell 是纯 TS 供应商注册表层，不依赖 DOM / Tauri IPC——因此这里全部是内存级断言，
 * 不需要 mock 运行时。预设（DEFAULT_AGENT_PROVIDERS / DEFAULT_MODEL_PROVIDERS）用结构
 * 不变量约束：防止随手改坏注册表（id 撞车、kind 写错、把 enabled 开一排）导致设置页
 * 或选择器在下游静默出错。
 *
 * 只测 shell 自己导出的符号（../src/index），下游 store 里的再解释在 workbench 侧。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_PROVIDERS,
  DEFAULT_MODEL_PROVIDERS,
  REASONING_EFFORTS,
  REASONING_LABELS,
  agentProviderIcon,
  agentProviderLobeIcon,
  createAgentProviderRegistry,
} from "../../src";
import type { AgentProviderConfig } from "../../src/providers";
import type { ModelProviderConfig, ReasoningEffort } from "../../src/types";

describe("agentProviderIcon", () => {
  it("用户没选图标时回到兜底 robot", () => {
    expect(agentProviderIcon({})).toBe("robot");
    expect(agentProviderIcon({ icon: undefined })).toBe("robot");
  });

  it("用户自定义图标优先于兜底", () => {
    expect(agentProviderIcon({ icon: "github" })).toBe("github");
  });
});

describe("agentProviderLobeIcon", () => {
  it("预设 id 命中 Lobe 图标表", () => {
    expect(agentProviderLobeIcon({ id: "opencode" })).toEqual({ slug: "opencode", type: "mono" });
    expect(agentProviderLobeIcon({ id: "claude-code" })).toEqual({ slug: "claudecode", type: "color" });
    expect(agentProviderLobeIcon({ id: "kimi" })).toEqual({ slug: "moonshot", type: "mono" });
  });

  it("用户自定义 icon 时不再回退 Lobe 资源（外部资源加载是成本，能省则省）", () => {
    expect(agentProviderLobeIcon({ id: "opencode", icon: "robot" })).toBeNull();
  });

  it("预设未覆盖的 id 返回 null", () => {
    expect(agentProviderLobeIcon({ id: "not-a-preset" })).toBeNull();
  });
});

describe("DEFAULT_AGENT_PROVIDERS 结构不变量", () => {
  it("id 全局唯一——注册表 Map 按 id 索引，撞车就是静默覆盖", () => {
    const ids = DEFAULT_AGENT_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("全部是 acp kind——注册表 set() 只接受 acp，出厂预设不敢越界", () => {
    for (const provider of DEFAULT_AGENT_PROVIDERS) expect(provider.kind).toBe("acp");
  });

  it("每条都有非空 id / name / command——选择器与启动都靠它们", () => {
    for (const provider of DEFAULT_AGENT_PROVIDERS) {
      expect(provider.id.trim()).not.toBe("");
      expect(provider.name.trim()).not.toBe("");
      expect(provider.command.trim()).not.toBe("");
      expect(provider.detect).toBeDefined();
    }
  });

  it("默认开且只开 opencode——其余一律关，出厂不带风险状态", () => {
    const enabled = DEFAULT_AGENT_PROVIDERS.filter((provider) => provider.enabled);
    expect(enabled.map((provider) => provider.id)).toEqual(["opencode"]);
  });

  it("开着的预设必须被 detect 探针覆盖到——不然开了也无法确认本机可用", () => {
    for (const provider of DEFAULT_AGENT_PROVIDERS.filter((p) => p.enabled)) {
      expect(provider.detect?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("12 个预设齐全且型号齐全（识别图标表与设置页展示用）", () => {
    expect(DEFAULT_AGENT_PROVIDERS).toHaveLength(12);
  });
});

describe("DEFAULT_MODEL_PROVIDERS 结构不变量", () => {
  it("id 全局唯一", () => {
    const ids = DEFAULT_MODEL_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("四种 kind 各自齐活（设置页按 kind 渲染表单）", () => {
    const kinds = new Set(DEFAULT_MODEL_PROVIDERS.map((provider) => provider.kind));
    expect([...kinds].sort()).toEqual(["anthropic", "custom", "ollama", "openai-compatible"]);
  });

  it("开着的供应商必须给出 baseUrl + model + apiKeyEnv——连不上/没密钥会直接报错", () => {
    const enabled = DEFAULT_MODEL_PROVIDERS.filter((provider) => provider.enabled);
    expect(enabled.length).toBeGreaterThan(0);
    for (const provider of enabled) {
      expect(provider.baseUrl?.trim() ?? "").not.toBe("");
      expect(provider.model.trim()).not.toBe("");
      expect(provider.apiKeyEnv?.trim() ?? "").not.toBe("");
    }
  });

  it("枚举本身的形状稳定：id/kind/model 必填，baseUrl/apiKeyEnv 可真可缺（本地供应商可无密钥）", () => {
    for (const provider of DEFAULT_MODEL_PROVIDERS satisfies ModelProviderConfig[]) {
      expect(provider.id).toBeTruthy();
      expect(typeof provider.kind).toBe("string");
      expect(typeof provider.model).toBe("string");
      // 类型契约里这两项可选：不强制为存在，但存在时必须是字符串
      if ("baseUrl" in provider) expect(typeof provider.baseUrl).toBe("string");
      if ("apiKeyEnv" in provider) expect(typeof provider.apiKeyEnv).toBe("string");
    }
  });
});

describe("createAgentProviderRegistry", () => {
  it("出厂即带全部默认预设", () => {
    const registry = createAgentProviderRegistry();
    expect(registry.list().map((provider) => provider.id)).toEqual(DEFAULT_AGENT_PROVIDERS.map((provider) => provider.id));
  });

  it("list() 返回的是可写数组但共享对象引用——改属性会漏进注册表", () => {
    // 这是实现现状的记录（不是契约）：Array.from 只复制了外层数组。
    const registry = createAgentProviderRegistry();
    const snapshot = registry.list();
    snapshot[0]!.enabled = !snapshot[0]!.enabled;
    expect(registry.list()[0]!.enabled).toBe(snapshot[0]!.enabled);
  });

  it("get 已知 id 返回预设，未知 id 返回 undefined", () => {
    const registry = createAgentProviderRegistry();
    expect(registry.get("opencode")?.command).toBe("opencode acp");
    expect(registry.get("ghost")).toBeUndefined();
  });

  it("set 新增预设后 list/get 立即可见", () => {
    const registry = createAgentProviderRegistry();
    const custom: AgentProviderConfig = {
      id: "my-agent",
      name: "My Agent",
      kind: "acp",
      command: "my-agent acp",
      enabled: false,
    };
    registry.set(custom);
    expect(registry.get("my-agent")).toEqual(custom);
    expect(registry.list().map((provider) => provider.id)).toContain("my-agent");
  });

  it("set 同 id 覆盖旧预设（不改 id 语义，更新的只是配置）", () => {
    const registry = createAgentProviderRegistry();
    registry.set({ ...registry.get("opencode")!, enabled: false, command: "opencode acp --theme mono" });
    expect(registry.get("opencode")).toMatchObject({ enabled: false, command: "opencode acp --theme mono" });
  });

  it("set 缺 id 抛错", () => {
    const registry = createAgentProviderRegistry();
    expect(() => registry.set({ id: "", name: "x", kind: "acp", command: "x", enabled: false })).toThrow("provider.id is required");
  });

  it("set 非 acp kind 抛错（模型供应商不进这个注册表）", () => {
    const registry = createAgentProviderRegistry();
    // set() 的类型签名只收 kind: 'acp'，这里绕一下类型模拟「跑着跑着冒出来的坏配置」
    const bad = {
      id: "bad",
      name: "x",
      kind: "ollama",
      command: "x",
      enabled: false,
    } as unknown as AgentProviderConfig;
    expect(() => registry.set(bad)).toThrow("agent provider kind must be 'acp'");
  });
});

describe("推理等级枚举", () => {
  it("REASONING_EFFORTS 顺序固定：auto → low → medium → high → max", () => {
    expect(REASONING_EFFORTS.map((entry) => entry.value)).toEqual(["auto", "low", "medium", "high", "max"]);
  });

  it("REASONING_LABELS 覆盖全部五档，且 i18n key 形如 reasoning.<档>.label", () => {
    const efforts: ReasoningEffort[] = ["auto", "low", "medium", "high", "max"];
    for (const effort of efforts) {
      expect(REASONING_LABELS[effort]).toBe(`reasoning.${effort}.label`);
    }
  });

  it("EFFORTS 与 LABELS 的键集合一致——两者漂移会让选择器漏档", () => {
    const effortValues = REASONING_EFFORTS.map((entry) => entry.value);
    expect(Object.keys(REASONING_LABELS).sort()).toEqual([...effortValues].sort());
  });

  it("每项的 label/description 都可走 i18n——渲染侧不拼字符串", () => {
    for (const entry of REASONING_EFFORTS) {
      expect(entry.label).toBe(`reasoning.${entry.value}.label`);
      expect(entry.description).toBe(`reasoning.${entry.value}.description`);
    }
  });
});
