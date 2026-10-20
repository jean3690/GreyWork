import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEV_PORT,
  devServerArgs,
  devServerEnv,
  devServerOrigin,
  devServerPort,
  isDevServerEnabled,
  sidecarOrigin,
} from "../src/shared/dev-server-spec";

describe("dev server 启动规格", () => {
  it("打包态恒不起 dev server；未打包默认起，只有显式 DIST 逃生舱才关", () => {
    expect(isDevServerEnabled(true, {})).toBe(false);
    // 打包态即便带了逃生舱变量也不认（生产绝不 spawn Vite）。
    expect(isDevServerEnabled(true, { GREYWORK_ELECTRON_DIST: "1" })).toBe(false);
    expect(isDevServerEnabled(false, {})).toBe(true);
    expect(isDevServerEnabled(false, { GREYWORK_ELECTRON_DIST: "1" })).toBe(false);
  });

  it("端口默认 1420，可被 GREYWORK_DEV_PORT 覆盖，非法值回落缺省", () => {
    expect(devServerPort({})).toBe(DEFAULT_DEV_PORT);
    expect(devServerPort({ GREYWORK_DEV_PORT: "1500" })).toBe(1500);
    for (const bad of ["", "abc", "0", "-1", "70000", "1420.5"]) {
      expect(devServerPort({ GREYWORK_DEV_PORT: bad })).toBe(DEFAULT_DEV_PORT);
    }
  });

  it("origin 用 127.0.0.1：与 cookie 写入 host 逐字一致，避开 localhost 的 IPv6 歧义", () => {
    expect(devServerOrigin(1420)).toBe("http://127.0.0.1:1420");
    expect(sidecarOrigin(17844)).toBe("http://127.0.0.1:17844");
  });

  it("子进程 env 注入 /api 反代 target、保留其余变量、并删掉 TAURI_DEV_HOST", () => {
    const env = devServerEnv({ PATH: "/ambient", KEEP: "me", TAURI_DEV_HOST: "192.168.1.9" }, 17844);

    expect(env.GREYWORK_SERVER_URL).toBe("http://127.0.0.1:17844");
    expect(env.PATH).toBe("/ambient");
    expect(env.KEEP).toBe("me");
    // 留着它会让 vite-config 把 server.host 切成该值、HMR 另指 1421，与「同机 Electron」相冲。
    expect(env.TAURI_DEV_HOST).toBeUndefined();
  });

  it("vite 参数钉死 host / port / strictPort", () => {
    expect(devServerArgs(1420)).toEqual(["exec", "vite", "--host", "127.0.0.1", "--port", "1420", "--strictPort"]);
  });
});
