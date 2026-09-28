// 云端 Office 预览的决策矩阵。
//
// 这份测试守的是**默认关闭**这条硬要求：没配服务商时任何 tab 都必须走本地 viewer，
// 行为与加这个功能之前逐字节一致。开启后的每个否决条件（来源不是磁盘、kind 不支持、
// 只有开关没配方）也都单列 —— 它们各自的失效方式都是「配了却不生效」，最难排查。
import { describe, expect, it } from "vitest";
import type { OfficeProviderConfig } from "@greywork/shell";
import {
  CLOUD_OFFICE_KINDS,
  canonicalOrigin,
  cloudOfficePath,
  cloudOfficeProviderFor,
  isOriginEmbeddable,
  shouldUseCloudOffice,
  unembeddableFrameOrigin,
} from "@/lib/office-preview";
import type { PreviewTab } from "@/stores/preview";

const RECIPE = {
  method: "POST" as const,
  url: "https://docs.example.com/upload",
  body: "multipart" as const,
  viewUrlPointer: "/data/url",
};

function provider(overrides: Partial<OfficeProviderConfig> = {}): OfficeProviderConfig {
  return {
    id: "vendor",
    name: "Vendor",
    family: "office",
    kind: "custom",
    enabled: true,
    recipe: RECIPE,
    ...overrides,
  };
}

function tab(overrides: Partial<PreviewTab> = {}): PreviewTab {
  return {
    id: "pv-1",
    path: "/work/report.docx",
    name: "report.docx",
    kind: "docx",
    source: "disk",
    revision: 1,
    ...overrides,
  };
}

describe("cloudOfficePath", () => {
  it("磁盘源直接用 tab.path", () => {
    expect(cloudOfficePath(tab())).toBe("/work/report.docx");
  });

  it("vfs 产物取落盘孪生路径；没落盘则为 null", () => {
    expect(cloudOfficePath(tab({ source: "vfs", path: "out/report.docx", diskPath: "/work/out/report.docx" }))).toBe(
      "/work/out/report.docx",
    );
    expect(cloudOfficePath(tab({ source: "vfs", path: "out/report.docx" }))).toBeNull();
  });

  it("web 源没有宿主可读路径", () => {
    expect(cloudOfficePath(tab({ source: "web", path: "https://example.com/a.docx" }))).toBeNull();
  });
});

describe("cloudOfficeProviderFor", () => {
  it("未配服务商 → 一直走本地（默认关闭）", () => {
    expect(shouldUseCloudOffice(tab(), [])).toBe(false);
    expect(cloudOfficeProviderFor(tab(), [])).toBeNull();
  });

  it("配了且启用且有配方 → 命中", () => {
    const vendors = [provider()];
    expect(shouldUseCloudOffice(tab(), vendors)).toBe(true);
    expect(cloudOfficeProviderFor(tab(), vendors)?.id).toBe("vendor");
  });

  it("只有开关没有配方不算可用（否则会先失败一次再回落）", () => {
    expect(shouldUseCloudOffice(tab(), [provider({ recipe: undefined })])).toBe(false);
  });

  it("未启用不算可用", () => {
    expect(shouldUseCloudOffice(tab(), [provider({ enabled: false })])).toBe(false);
  });

  it("选中项优先；选中的不可用时回落第一个可用的", () => {
    const a = provider({ id: "a" });
    const b = provider({ id: "b" });
    expect(cloudOfficeProviderFor(tab(), [a, b], "b")?.id).toBe("b");
    // 选中的 b 被停用 → 用 a，而不是干脆不用云端。
    expect(cloudOfficeProviderFor(tab(), [a, { ...b, enabled: false }], "b")?.id).toBe("a");
  });

  it("非磁盘源不走云端", () => {
    expect(shouldUseCloudOffice(tab({ source: "web" }), [provider()])).toBe(false);
  });

  it("kind 不支持时即使配好也不走云端", () => {
    expect(shouldUseCloudOffice(tab({ kind: "pdf" }), [provider()])).toBe(false);
    expect(shouldUseCloudOffice(tab({ kind: "image" }), [provider()])).toBe(false);
  });

  it("云端覆盖的 kind 覆盖到本地渲染不了的老格式", () => {
    for (const kind of ["docx", "pptx", "xlsx", "xls", "legacy-office"] as const) {
      expect(CLOUD_OFFICE_KINDS.has(kind), `${kind} 应在云端覆盖范围内`).toBe(true);
      expect(shouldUseCloudOffice(tab({ kind }), [provider()]), `${kind} 应命中云端`).toBe(true);
    }
    // .doc/.ppt 这类本地只能给占位提示的，是云端收益最大的面 —— 单独钉一句。
    expect(shouldUseCloudOffice(tab({ kind: "legacy-office", name: "old.doc" }), [provider()])).toBe(true);
  });
});

// 内嵌可行性：宿主 CSP 只放行白名单里的 origin，不在表里就是 iframe 白屏且控制台之外
// 看不到报错。这组用例守的是「归一化后比对」——两边形态不一致就会误判成「配了却不生效」。
describe("canonicalOrigin / isOriginEmbeddable", () => {
  it("归一化：剥尾斜杠、小写、丢弃路径", () => {
    expect(canonicalOrigin("https://Docs.Example.com/")).toBe("https://docs.example.com");
    expect(canonicalOrigin("https://docs.example.com/a/b")).toBe("https://docs.example.com");
    expect(canonicalOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    // 解析不出 origin 的输入不抛错（比对时自然不命中任何白名单项）。
    expect(canonicalOrigin("not a url")).toBe("not a url");
  });

  it("命中白名单（大小写与尾斜杠不影响）", () => {
    const allowed = ["https://docs.example.com"];
    expect(isOriginEmbeddable("https://docs.example.com/d/42", allowed)).toBe(true);
    expect(isOriginEmbeddable("https://DOCS.example.com/d/42", allowed)).toBe(true);
    expect(isOriginEmbeddable("https://docs.example.com:443/d/42", allowed)).toBe(true);
  });

  it("不命中：换了域名、或白名单为空（无 frame-src = 跨源一律不放行）", () => {
    expect(isOriginEmbeddable("https://evil.example.com/d/42", ["https://docs.example.com"])).toBe(false);
    expect(isOriginEmbeddable("https://docs.example.com/d/42", [])).toBe(false);
    expect(isOriginEmbeddable("不是地址", ["https://docs.example.com"])).toBe(false);
  });
});

describe("unembeddableFrameOrigin（上传前预检）", () => {
  it("声明的域名不在白名单 → 返回归一化后的它", () => {
    expect(unembeddableFrameOrigin({ frameOrigin: "https://Custom.Example.com/" }, ["https://docs.example.com"])).toBe(
      "https://custom.example.com",
    );
  });

  it("声明的域名在白名单 → null（放行）", () => {
    expect(unembeddableFrameOrigin({ frameOrigin: "https://docs.example.com" }, ["https://docs.example.com"])).toBeNull();
  });

  it("未声明 frameOrigin → null（无从预检，交给上传后的权威校验）", () => {
    expect(unembeddableFrameOrigin({}, ["https://docs.example.com"])).toBeNull();
    expect(unembeddableFrameOrigin({ frameOrigin: "   " }, ["https://docs.example.com"])).toBeNull();
  });
});
