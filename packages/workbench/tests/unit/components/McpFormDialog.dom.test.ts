import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import McpFormDialog from "@/components/settings/McpFormDialog.vue";

function render(existingNames: string[] = []) {
  return mount(McpFormDialog, {
    props: { open: true, entry: null, preset: null, existingNames },
  });
}

describe("McpFormDialog", () => {
  it("拒绝重复名称与非 http(s) URL", async () => {
    const duplicate = render(["DeepWiki"]);
    await duplicate.get('[data-testid="mcp-name"]').setValue("deepwiki");
    await duplicate.get('[data-testid="mcp-url"]').setValue("https://example.com/mcp");
    await duplicate.get('[data-testid="mcp-save"]').trigger("click");
    expect(duplicate.text()).toContain("已存在");
    expect(duplicate.emitted("save")).toBeUndefined();

    const invalidUrl = render();
    await invalidUrl.get('[data-testid="mcp-name"]').setValue("files");
    await invalidUrl.get('[data-testid="mcp-url"]').setValue("file:///tmp/mcp");
    await invalidUrl.get('[data-testid="mcp-save"]').trigger("click");
    expect(invalidUrl.text()).toContain("http(s)");
    expect(invalidUrl.emitted("save")).toBeUndefined();
  });

  it("stdio 参数按行保存，参数内部空格不被拆开，空环境变量不注入", async () => {
    const wrapper = render();
    await wrapper.get('[data-testid="mcp-name"]').setValue("local-files");
    await wrapper.get("select").setValue("stdio");
    await wrapper.get('input[placeholder="npx 或 /usr/bin/npx"]').setValue("npx");
    await wrapper.get('[data-testid="mcp-args"]').setValue("-y\n@modelcontextprotocol/server-filesystem\n/home/Jean Grey/notes");
    await wrapper.get('input[placeholder="KEY"]').setValue("OPTIONAL_TOKEN");
    await wrapper.get('[data-testid="mcp-save"]').trigger("click");

    expect(wrapper.emitted("save")?.[0]?.[0]).toEqual({
      name: "local-files",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/Jean Grey/notes"],
      env: {},
      headers: undefined,
    });
  });

  it("registry stdio 草稿预填命令与参数，保存即 stdio 载荷", async () => {
    // 父级常驻挂载、以 open 翻转触发 reset；这里同样先 false 再置 true。
    const wrapper = mount(McpFormDialog, {
      props: {
        open: false,
        entry: null,
        existingNames: [],
        preset: {
          source: "registry",
          registry: { name: "ac.x/mcp", remotes: [], packages: [] },
          name: "files",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          envHint: ["ROOT"],
        },
      },
    });
    await wrapper.setProps({ open: true });

    expect((wrapper.get('input[placeholder="npx 或 /usr/bin/npx"]').element as HTMLInputElement).value).toBe("npx");
    expect((wrapper.get('[data-testid="mcp-args"]').element as HTMLTextAreaElement).value).toBe(
      "-y\n@modelcontextprotocol/server-filesystem",
    );

    await wrapper.get('[data-testid="mcp-save"]').trigger("click");
    expect(wrapper.emitted("save")?.[0]?.[0]).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    });
  });

  it("鉴权值默认以密码框呈现，可显式切换显示", async () => {
    const wrapper = render();
    const secret = wrapper.get('input[placeholder="值"]');
    expect(secret.attributes("type")).toBe("password");
    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "显示值")!
      .trigger("click");
    expect(secret.attributes("type")).toBe("text");
  });
});
