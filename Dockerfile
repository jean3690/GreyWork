# syntax=docker/dockerfile:1

########## 1) 构建前端 SPA（纯 Node 工具链，不碰 Rust/Tauri） ##########
FROM node:22-bookworm-slim AS web
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /src
COPY . .
# 可选：构建期换 registry（内网镜像 / 私有源 / 慢网环境的加速镜像）：
#   docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com .
# 不传就用 pnpm 的默认（registry.npmjs.org）。容器里读不到宿主 ~/.npmrc，
# 所以镜像源必须显式给 —— 否则直连 npmjs 慢网下 pnpm 会大批请求超时。
ARG NPM_REGISTRY
# 只构建渲染端（vue-tsc --noEmit + vite build → apps/desktop/dist）；不跑 tauri。
RUN --mount=type=cache,id=gw-pnpm,target=/pnpm/store \
    if [ -n "$NPM_REGISTRY" ]; then export npm_config_registry="$NPM_REGISTRY"; fi && \
    pnpm install --frozen-lockfile && pnpm build

########## 2) 构建 headless 服务端二进制 ##########
FROM rust:1-bookworm AS server
# rusqlite(bundled) 要 C 编译器（基础镜像已带 gcc/make）；rustls 的 aws-lc-rs 要 cmake。
RUN apt-get update && apt-get install -y --no-install-recommends cmake \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# -p greywork-server 只编译该包 + greywork-host，不牵扯桌面壳（Tauri/WebKit 系统依赖）。
RUN --mount=type=cache,id=gw-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=gw-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=gw-cargo-target,target=/src/target \
    cargo build --release --locked -p greywork-server \
    && cp target/release/greywork-server /usr/local/bin/greywork-server

########## 3) 运行时（最小面：无 Node、无构建工具） ##########
FROM debian:bookworm-slim AS runtime
# git：git_* 命令走系统 git CLI；ca-certificates：出站 HTTPS（模型 / 通道）验证根证书。
# ACP agent 运行时（node / npx / python3 / uvx …）本镜像不含 —— 按需在派生镜像里装，
# 并用 GREYWORK_AGENT_PROGRAMS 显式放行（白名单是冻结的，只信配置，不读 DB）。
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
# 非 root 运行；挂载 /data 卷时注意宿主目录属主应为 uid=10001。
#
# /data 必须在镜像里就存在且属于运行用户：Docker 新建（匿名或命名）卷时会**继承镜像里
# 该路径的属主**，不预先建好就是 root:root，uid 10001 连库文件都建不出来 —— 症状是容器
# 启动即 `打开数据库失败: unable to open database file: /data/greywork.db`。
RUN useradd --system --create-home --home-dir /home/greywork --uid 10001 greywork \
    && mkdir -p /data \
    && chown greywork:greywork /data
COPY --from=server /usr/local/bin/greywork-server /usr/local/bin/greywork-server
COPY --from=web /src/apps/desktop/dist /app/web
ENV GREYWORK_BIND=0.0.0.0:8787 \
    GREYWORK_STATIC_DIR=/app/web \
    GREYWORK_DATA_DIR=/data \
    GREYWORK_HOME_DIR=/home/greywork
VOLUME ["/data"]
EXPOSE 8787
USER greywork
# 内置探针（镜像无 curl / wget）：连本机 /api/health，200 → 退出 0。
# 静态托管缺 index.html 会启动硬失败，探针据此不会「healthy 但 UI 404」。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["greywork-server", "healthcheck"]
# 无子命令 → 起服务；也可 `docker run … greywork-server hash-password` 生成密码哈希。
ENTRYPOINT ["greywork-server"]
