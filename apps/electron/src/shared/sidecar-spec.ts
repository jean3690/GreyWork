/**
 * sidecar 启动参数的**纯规格**（常量 / 纯函数：脱开 Electron 与 node:child_process 也能单测）。
 *
 * 核心是「**父死子死**」。Electron 主进程被**强杀**时，`before-quit` 不会跑、SIGTERM 也不会发：
 * 最典型的场景是 WSLg（WSL 的图形子系统）崩溃导致 Chromium 的 X 连接中断，主进程直接
 * `FATAL: Failed to shutdown` / SIGTRAP。此时 sidecar 若没人收尸就成了孤儿，一直占着端口和
 * 数据目录；下次启动只能顺延端口，而 localStorage 按 origin（协议 + 主机 + **端口**）隔离，
 * 端口一变渲染层读到的就是另一份空存储，用户表现为「工作区/设置又没了」。
 *
 * 解法：stdin 由父进程持一根管道 + `GREYWORK_EXIT_ON_STDIN_EOF=1`。父进程一消失（哪怕
 * SIGKILL）写端就关，server 读到 EOF 自行退出 —— 见 apps/server 的 `shutdown_signal`。
 */

/** spawn 的 stdio：stdin 走管道（「父死子死」的通道），stdout/stderr 继承终端。 */
export const SIDECAR_STDIO: ["pipe", "inherit", "inherit"] = ["pipe", "inherit", "inherit"];

/** sidecar 的环境变量（在 `base` 之上的覆盖项）。 */
export function sidecarEnv(input: {
  /** 主进程的 `process.env`。 */
  readonly base: NodeJS.ProcessEnv;
  /** 登录 shell 里取出的 PATH；agent CLI 探测靠它。 */
  readonly shellPath: string;
  readonly port: number;
  readonly staticDir: string;
  readonly dataDir: string;
  readonly passwordHash: string;
}): NodeJS.ProcessEnv {
  return {
    ...input.base,
    PATH: input.shellPath,
    GREYWORK_BIND: `127.0.0.1:${input.port}`,
    GREYWORK_STATIC_DIR: input.staticDir,
    GREYWORK_DATA_DIR: input.dataDir,
    GREYWORK_PASSWORD_HASH: input.passwordHash,
    // 本机可信宿主：sidecar 就绑在环回上、只服务本窗口。开启后服务端解除三处
    // 「网络暴露部署」的 fail-closed 加固 —— 不再钳制 ACP 沙箱/档位、放行
    // db_agents_sync、acp_start 改读 DB 里的后端目录（见 apps/server config::apply_trusted_host）。
    GREYWORK_TRUSTED_HOST: "1",
    // 父死子死：stdin 是父进程持有的管道（见 SIDECAR_STDIO），读到 EOF 即退出。
    GREYWORK_EXIT_ON_STDIN_EOF: "1",
  };
}
