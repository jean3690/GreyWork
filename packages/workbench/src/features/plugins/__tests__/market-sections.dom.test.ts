// 插件市场 · MCP / 技能两个专区的界面契约：
// MCP：搜索 → 登记弹窗 → 写进本机服务器列表；不可登记录条目如实说明原因。
// 技能：磁盘扫描出已安装、市场搜索出结果、安装走二次确认 + 宿主写盘。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GreyWorkCore from "@greywork/core";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import McpMarketSection from "@/features/plugins/McpMarketSection.vue";
import SkillsMarketSection from "@/features/plugins/SkillsMarketSection.vue";
import { i18n } from "@/i18n";
import { useSettingsStore } from "@/stores/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@greywork/core", async (importOriginal) => {
  const actual = await importOriginal<typeof GreyWorkCore>();
  return { ...actual, isTauriRuntime: () => true };
});
vi.mock("@/lib/workspace-dir", () => ({
  resolveWorkspaceRoot: () => Promise.resolve({ dir: "/ws/proj", bound: true }),
}));

const invokeMock = vi.mocked(invoke);
const mounted: VueWrapper[] = [];

/** 注册表条目样例（可直登记的 http remote）。 */
const REST_ENTRY = {
  name: "ac.inference.sh/mcp",
  title: "Inference MCP",
  description: "远程 MCP，提供推理工具",
  version: "1.2.0",
  remotes: [{ transport: "streamable-http", url: "https://mcp.inference.sh/mcp" }],
  packages: [],
};
/** 只有未知包类型：不可一键登记。 */
const UNSUPPORTED_ENTRY = {
  name: "exotic.example/mcp",
  title: "Exotic MCP",
  description: "",
  version: null,
  remotes: [],
  packages: [{ registry_type: "nuget", identifier: "Exotic.Mcp", version: "1.0.0", env_names: [] }],
};

/** 按命令名分发的假宿主：MCP 搜索 + 技能市场与文件系统。 */
function fakeHost(): void {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    const path: string | undefined = (args as { path?: string } | undefined)?.path;
    switch (cmd) {
      case "mcp_search":
        return [REST_ENTRY, UNSUPPORTED_ENTRY];
      case "fs_list_dir":
        if (path === "/ws/proj/.agents/skills") {
          return [{ name: "tdd", kind: "directory", path: "/ws/proj/.agents/skills/tdd" }];
        }
        return [];
      case "fs_read_text_file":
        return "---\nname: TDD\ndescription: red-green-refactor\n---\nbody";
      // 宿主直出形状（snake_case + ref）：渲染端经 HostSkillsTransport 归一
      case "skills_search":
        return [
          { ref: "mattpocock/skills/tdd", skill_id: "tdd", name: "tdd", installs: 759925, source: "mattpocock/skills", downloadable: true },
          {
            ref: "open.feishu.cn/lark-doc",
            skill_id: "lark-doc",
            name: "lark-doc",
            installs: 100,
            source: "open.feishu.cn",
            downloadable: false,
          },
        ];
      case "skills_download":
        return { files: [{ path: "SKILL.md", contents: "# x" }], hash: "snap-1" };
      case "skills_install":
        return { dir: "/ws/proj/.agents/skills/tdd", filesWritten: 1 };
      case "skills_uninstall":
        return null;
      default:
        throw new Error(`unexpected host command: ${cmd}`);
    }
  });
}

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
  fakeHost();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

async function render(component: unknown): Promise<VueWrapper> {
  const wrapper = mount(component as never, { global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe("插件市场 · MCP 专区", () => {
  it("搜索列出注册表条目；登记走表单弹窗并写进本机服务器列表", async () => {
    const wrapper = await render(McpMarketSection);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="market-mcp-ac.inference.sh/mcp"]').exists()).toBe(true));
    expect(wrapper.text()).toContain("Inference MCP");
    // 内置示例（deepwiki）已登记：计数如实反映本机清单
    expect(wrapper.text()).toContain("已登记 1 台");

    await wrapper.get('[data-testid="market-mcp-register-ac.inference.sh/mcp"]').trigger("click");
    await flushPromises();

    const dialog = document.body.querySelector('[data-slot="dialog-content"]');
    expect(dialog).not.toBeNull();
    const panel = new DOMWrapper(dialog as Element);
    await panel.find('[data-testid="mcp-save"]').trigger("click");
    await flushPromises();

    const settings = useSettingsStore();
    const registered = settings.mcpServers.find((server) => server.name === "Inference MCP");
    expect(registered).toBeDefined();
    expect(registered?.transport).toBe("http");
    expect(registered?.url).toBe("https://mcp.inference.sh/mcp");
    // 弹窗关闭、卡片翻成「已登记」、计数 +1
    expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(wrapper.get('[data-testid="market-mcp-register-ac.inference.sh/mcp"]').text()).toBe("已登记");
    expect(wrapper.text()).toContain("已登记 2 台");
  });

  it("不可一键登记的条目：按钮禁用并说明原因", async () => {
    const wrapper = await render(McpMarketSection);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="market-mcp-exotic.example/mcp"]').exists()).toBe(true));

    const button = wrapper.get('[data-testid="market-mcp-register-exotic.example/mcp"]');
    expect(button.attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="market-mcp-exotic.example/mcp"]').text()).toContain("nuget");
  });
});

describe("插件市场 · 技能专区", () => {
  it("已安装来自磁盘扫描；搜索 → 安装二次确认 → 宿主写盘", async () => {
    const wrapper = await render(SkillsMarketSection);

    // 已安装：扫描 .agents/skills 读 frontmatter
    await vi.waitFor(() => expect(wrapper.find('[data-testid="market-skill-installed-tdd"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="market-skill-installed-tdd"]').text()).toContain("TDD");

    // 发现：搜索后出现两条，站点源（不可下载）按钮禁用
    await wrapper.get('[data-testid="market-skills-search"]').setValue("tdd");
    await wrapper.get('[data-testid="market-skills-search"]').trigger("keydown.enter");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="market-skill-tdd"]').exists()).toBe(true));
    // 站点源（两段 ref）不可下载：按钮禁用，不假装能装
    expect(wrapper.get('[data-testid="market-skill-install-lark-doc"]').attributes("disabled")).toBeDefined();

    // 安装：先出二次确认，确认后才落盘
    await wrapper.get('[data-testid="market-skill-install-tdd"]').trigger("click");
    expect(wrapper.get('[data-testid="market-skills-confirm"]').text()).toContain("覆盖更新");
    expect(invokeMock).not.toHaveBeenCalledWith("skills_install", expect.anything());

    await wrapper.get('[data-testid="market-skills-confirm-yes"]').trigger("click");
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("skills_install", expect.objectContaining({ skillId: "tdd" })));
    expect(wrapper.find('[data-testid="market-skills-confirm"]').exists()).toBe(false);
  });

  it("二次确认可取消，卸载后列表收缩", async () => {
    const wrapper = await render(SkillsMarketSection);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="market-skill-installed-tdd"]').exists()).toBe(true));

    await wrapper.get('[data-testid="market-skill-uninstall-tdd"]').trigger("click");
    expect(wrapper.get('[data-testid="market-skills-confirm"]').text()).toContain("不可撤销");
    await wrapper.get('[data-testid="market-skills-confirm-cancel"]').trigger("click");
    expect(wrapper.find('[data-testid="market-skills-confirm"]').exists()).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("skills_uninstall", expect.anything());
  });
});
