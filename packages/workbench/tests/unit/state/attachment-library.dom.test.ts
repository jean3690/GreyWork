/**
 * 附件字节读取的契约。
 *
 * 这里守的是一个**真实踩过的坑**：`fs_read_binary` 从「base64 字符串」改成「原始字节
 * （tauri::ipc::Response → ArrayBuffer）」之后，`attachment-library` 里那处
 * `invoke<string>("fs_read_binary")` 直接拿 Rust 的 base64 当结果用的写法就失效了 ——
 * 它会拿到一个 ArrayBuffer 当 string 用。这条路径此前**一个测试都没有**（所有调用方
 * 都在别处被 mock 掉），所以只能靠这组用例把契约钉住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked((await import("@tauri-apps/api/core")).invoke);

import { materializeAttachments, readAttachmentBase64, readAttachmentBytes } from "@/state/attachment-library";
import type { Attachment } from "@/types";

/** "ABC" 的字节与 base64 —— 与别处用例里的 "QUJD" 同源。 */
const ABC = [0x41, 0x42, 0x43];
const ABC_BASE64 = "QUJD";

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return { id: "a1", kind: "image", name: "a.png", mime: "image/png", size: 3, ...overrides };
}

function enableTauri(): void {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("按路径读取附件", () => {
  it("命令回 ArrayBuffer 时自己编码成 base64（不再指望 Rust 侧给 base64）", async () => {
    enableTauri();
    invokeMock.mockResolvedValue(new Uint8Array(ABC).buffer);

    expect(await readAttachmentBase64(attachment({ path: "/tmp/a.png" }))).toBe(ABC_BASE64);
    expect(invokeMock).toHaveBeenCalledWith("fs_read_binary", { path: "/tmp/a.png" });
  });

  it("命令回的可能已经是视图：两种形状都要能读", async () => {
    enableTauri();
    invokeMock.mockResolvedValue(new Uint8Array(ABC));

    expect(await readAttachmentBase64(attachment({ path: "/tmp/a.png" }))).toBe(ABC_BASE64);
  });

  it("载荷形状不对时报错，而不是强转成一个错位的缓冲区", async () => {
    enableTauri();
    // 契约被改坏时，静默强转会让上层报「文件已损坏」，排查方向全跑到文件上
    invokeMock.mockResolvedValue({ unexpected: true } as never);

    await expect(readAttachmentBase64(attachment({ path: "/tmp/a.png" }))).rejects.toThrow(/非二进制载荷/);
  });

  it("readAttachmentBytes 同样吃 ArrayBuffer", async () => {
    enableTauri();
    invokeMock.mockResolvedValue(new Uint8Array(ABC).buffer);

    expect(Array.from(await readAttachmentBytes(attachment({ path: "/tmp/a.png" })))).toEqual(ABC);
  });

  it("没有 path 时走内联副本，不碰 IPC", async () => {
    enableTauri();

    const withDataUrl = attachment({ dataUrl: `data:image/png;base64,${ABC_BASE64}` });
    expect(await readAttachmentBase64(withDataUrl)).toBe(ABC_BASE64);
    expect(await readAttachmentBytes(withDataUrl)).toEqual(new Uint8Array(ABC));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("浏览器态（没有 Tauri 宿主）也走内联副本", async () => {
    invokeMock.mockResolvedValue(new Uint8Array(ABC).buffer);

    const withDataUrl = attachment({ path: "/tmp/a.png", dataUrl: `data:image/png;base64,${ABC_BASE64}` });
    expect(await readAttachmentBase64(withDataUrl)).toBe(ABC_BASE64);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("既没有 path 也没有内联数据时给出可读错误", async () => {
    enableTauri();

    await expect(readAttachmentBase64(attachment())).rejects.toThrow(/没有可读的图片数据/);
    await expect(readAttachmentBytes(attachment())).rejects.toThrow(/没有可读的数据源/);
  });

  it("草稿字节优先于 path（通用文件只在草稿期有数据）", async () => {
    enableTauri();
    // path 存在但磁盘上并没有这个文件：若没走 bytes，这里会因 invoke 返回 undefined 而报错。
    const draft = attachment({ kind: "file", name: "a.zip", mime: "application/zip", path: "/tmp/a.zip", bytes: new Uint8Array(ABC) });

    expect(Array.from(await readAttachmentBytes(draft))).toEqual(ABC);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("materializeAttachments", () => {
  it("落库后剥离草稿字节，只留 path（Uint8Array 不能进会话存档）", async () => {
    enableTauri();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "store_default_root" ? Promise.resolve("/tmp/gw-root") : Promise.resolve(undefined),
    );

    const draft = attachment({ kind: "file", name: "paper.pdf", mime: "application/pdf", bytes: new Uint8Array(ABC) });
    const [stored] = await materializeAttachments("s1", [draft]);

    expect(stored.bytes).toBeUndefined();
    expect(stored.path).toMatch(/attachments[/\\]s1[/\\]a1\.pdf$/);
    expect(invokeMock).toHaveBeenCalledWith("fs_write_binary", { path: stored.path, dataBase64: ABC_BASE64 });
  });

  it("没有文件系统（浏览器态）时也剥掉 bytes", async () => {
    const draft = attachment({ kind: "file", name: "paper.pdf", bytes: new Uint8Array(ABC) });

    const [stored] = await materializeAttachments("s1", [draft]);

    expect(stored.bytes).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
