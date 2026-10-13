// 「本轮能力」卡：MCP / 技能 chips 的勾选态与 v-model 回写。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "@/i18n";
import CoworkTooling from "@/features/team/CoworkTooling.vue";

const mcpServers = [
  { id: "deepwiki", name: "deepwiki", transport: "http" as const, url: "https://mcp.deepwiki.com/mcp", enabled: true },
  { id: "local", name: "local-tools", transport: "stdio" as const, command: "run", enabled: false },
];
const skills = [
  { id: "alpha", name: "Alpha", dir: "/ws/.agents/skills/alpha" },
  { id: "beta", name: "Beta", dir: "/ws/.agents/skills/beta" },
];

function mountTooling(mcp: string[], skillIds: string[], worktreeOnly = false) {
  return mount(CoworkTooling, {
    props: {
      mcpServers,
      skills,
      skillsLoading: false,
      worktreeOnly,
      selectedMcp: mcp,
      selectedSkills: skillIds,
      "onUpdate:selectedMcp": (value: string[]) => wrapper.setProps({ selectedMcp: value }),
      "onUpdate:selectedSkills": (value: string[]) => wrapper.setProps({ selectedSkills: value }),
    },
    global: { plugins: [i18n] },
  });
}

// 占位，便于内联事件处理器引用（在 mountTooling 内赋值）。
let wrapper: ReturnType<typeof mount>;

describe("CoworkTooling", () => {
  it("按选中集渲染 MCP / 技能 chips 的 aria-pressed", () => {
    wrapper = mountTooling(["deepwiki"], ["alpha"]);
    expect(wrapper.get('[data-testid="tooling-mcp-deepwiki"]').attributes("aria-pressed")).toBe("true");
    expect(wrapper.get('[data-testid="tooling-mcp-local"]').attributes("aria-pressed")).toBe("false");
    expect(wrapper.get('[data-testid="tooling-skill-alpha"]').attributes("aria-pressed")).toBe("true");
    expect(wrapper.get('[data-testid="tooling-skill-beta"]').attributes("aria-pressed")).toBe("false");
  });

  it("点技能 chip 发出 update:selectedSkills", async () => {
    wrapper = mountTooling([], ["alpha"]);
    await wrapper.get('[data-testid="tooling-skill-beta"]').trigger("click");
    const events = wrapper.emitted("update:selectedSkills");
    expect(events?.at(-1)).toEqual([["alpha", "beta"]]);

    await wrapper.get('[data-testid="tooling-skill-alpha"]').trigger("click");
    expect(wrapper.emitted("update:selectedSkills")?.at(-1)).toEqual([["beta"]]);
  });

  it("点 MCP chip 发出 update:selectedMcp", async () => {
    wrapper = mountTooling([], []);
    await wrapper.get('[data-testid="tooling-mcp-local"]').trigger("click");
    expect(wrapper.emitted("update:selectedMcp")?.at(-1)).toEqual([["local"]]);
  });

  it("worktreeOnly 时给出技能过滤范围说明", () => {
    wrapper = mountTooling([], ["alpha"], true);
    expect(wrapper.text()).toContain(i18n.global.t("cowork.tooling.skillsWorktreeOnly"));
  });
});
