import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import McpFormDialog from "@/features/settings/McpFormDialog.vue";

// 弹层已改为 shadcn Dialog，内容 Portal 到 body —— wrapper.find 够不到，
// 所以用 DOMWrapper 包住弹层根节点做选择器；事件仍从 mount 出的 wrapper 上取。
// 挂载必须 await：reka 的 Presence 在挂载后一个 tick 才渲染弹层内容。
const mounted: VueWrapper[] = [];

function dialog(): DOMWrapper<Element> {
  const el = document.body.querySelector('[data-slot="dialog-content"]');
  if (!el) throw new Error("未渲染出 dialog-content");
  return new DOMWrapper(el);
}

async function render(existingNames: string[] = []): Promise<VueWrapper> {
  const wrapper = mount(McpFormDialog, {
    props: { open: true, entry: null, preset: null, existingNames },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("McpFormDialog", () => {
  it("拒绝重复名称与非 http(s) URL", async () => {
    const duplicate = await render(["DeepWiki"]);
    await dialog().find('[data-testid="mcp-name"]').setValue("deepwiki");
    await dialog().find('[data-testid="mcp-url"]').setValue("https://example.com/mcp");
    await dialog().find('[data-testid="mcp-save"]').trigger("click");
    expect(dialog().text()).toContain("已存在");
    expect(duplicate.emitted("save")).toBeUndefined();

    const invalidUrl = await render();
    await dialog().find('[data-testid="mcp-name"]').setValue("files");
    await dialog().find('[data-testid="mcp-url"]').setValue("file:///tmp/mcp");
    await dialog().find('[data-testid="mcp-save"]').trigger("click");
    expect(dialog().text()).toContain("http(s)");
    expect(invalidUrl.emitted("save")).toBeUndefined();
  });

  it("stdio 参数按行保存，参数内部空格不被拆开，空环境变量不注入", async () => {
    const wrapper = await render();
    await dialog().find('[data-testid="mcp-name"]').setValue("local-files");
    await dialog().find("select").setValue("stdio");
    await dialog().find('input[placeholder="npx 或 /usr/bin/npx"]').setValue("npx");
    await dialog().find('[data-testid="mcp-args"]').setValue("-y\n@modelcontextprotocol/server-filesystem\n/home/Jean Grey/notes");
    await dialog().find('input[placeholder="KEY"]').setValue("OPTIONAL_TOKEN");
    await dialog().find('[data-testid="mcp-save"]').trigger("click");

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
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect((dialog().find('input[placeholder="npx 或 /usr/bin/npx"]').element as HTMLInputElement).value).toBe("npx");
    expect((dialog().find('[data-testid="mcp-args"]').element as HTMLTextAreaElement).value).toBe(
      "-y\n@modelcontextprotocol/server-filesystem",
    );

    await dialog().find('[data-testid="mcp-save"]').trigger("click");
    expect(wrapper.emitted("save")?.[0]?.[0]).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    });
  });

  it("鉴权值默认以密码框呈现，可显式切换显示", async () => {
    await render();
    const secret = dialog().find('input[placeholder="值"]');
    expect(secret.attributes("type")).toBe("password");
    await dialog()
      .findAll("button")
      .find((button) => button.text().trim() === "显示值")!
      .trigger("click");
    expect(secret.attributes("type")).toBe("text");
  });
});
