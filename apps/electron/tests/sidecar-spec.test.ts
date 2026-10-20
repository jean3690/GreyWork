import { describe, expect, it } from "vitest";

import { SIDECAR_STDIO, sidecarEnv } from "../src/shared/sidecar-spec";

describe("sidecar 启动规格", () => {
  it("stdin 走管道、stdout/stderr 继承：父死子死 + 日志照旧打在终端", () => {
    expect(SIDECAR_STDIO).toEqual(["pipe", "inherit", "inherit"]);
  });

  it("打开「stdin 关闭即退出」，同时保留宿主需要的其它变量", () => {
    const env = sidecarEnv({
      base: { PATH: "/ambient", KEEP: "me" },
      shellPath: "/login/bin",
      port: 17844,
      staticDir: "/repo/apps/desktop/dist",
      dataDir: "/home/u/.config/@greywork/electron/data",
      passwordHash: "$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA",
    });

    // 主进程被强杀（SIGKILL / WSLg 崩溃）时没有 SIGTERM 可发，全靠这条让 server 自己退，
    // 不然就会留个占着端口与 data 目录的孤儿。
    expect(env.GREYWORK_EXIT_ON_STDIN_EOF).toBe("1");
    // 端口固定：origin 稳定，localStorage 才不会「每次启动都空一份」。
    expect(env.GREYWORK_BIND).toBe("127.0.0.1:17844");
    expect(env.GREYWORK_STATIC_DIR).toBe("/repo/apps/desktop/dist");
    expect(env.GREYWORK_DATA_DIR).toBe("/home/u/.config/@greywork/electron/data");
    expect(env.GREYWORK_PASSWORD_HASH).toBe("$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA");
    expect(env.GREYWORK_TRUSTED_HOST).toBe("1");
    // 登录 shell 的 PATH 覆盖环境里那份；其余环境变量原样透传。
    expect(env.PATH).toBe("/login/bin");
    expect(env.KEEP).toBe("me");
  });
});
