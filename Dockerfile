# syntax=docker/dockerfile:1

########## 1) 构建前端 SPA（纯 Node 工具链，不碰 Rust/Tauri） ##########
FROM node:22-bookworm-slim AS web
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /src
COPY . .
# 根 pnpm install 会把整个 workspace 装进来，其中 apps/host-node 的 node-pty 是原生模块：
# 没有预编译二进制时 node-gyp 会现场编译（python3 + make + g++）。这里只用于构建前端，
# 但不装工具链就会在起 vite 之前先炸在 node-pty 上（见 2026-11 Docker 构建失败）。
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# 可选：构建期换 registry（内网镜像 / 私有源 / 慢网环境的加速镜像）：
#   docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com .
# 不传就用 pnpm 的默认（registry.npmjs.org）。容器里读不到宿主 ~/.npmrc，
# 所以镜像源必须显式给 —— 否则直连 npmjs 慢网下 pnpm 会大批请求超时。
ARG NPM_REGISTRY
# 只构建本镜像要托管的那一端（vue-tsc --noEmit + vite build → apps/desktop/dist）。
# apps/web 是另一个部署，不在这个镜像里；用 `pnpm build` 会把两端都构建一遍，白白多花几分钟。
RUN --mount=type=cache,id=gw-pnpm,target=/pnpm/store \
    if [ -n "$NPM_REGISTRY" ]; then export npm_config_registry="$NPM_REGISTRY"; fi && \
    pnpm install --frozen-lockfile && pnpm build:desktop

########## 2) 构建 Node 宿主（apps/host-node，含原生模块 node-pty 的编译） ##########
FROM node:22-bookworm-slim AS server
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
# node-pty 是原生模块：安装期要 node-gyp 编译（python3 + make + g++）。
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=gw-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile && pnpm --filter @greywork/host-node build
# deploy 产出独立目录：dist + 生产依赖（node-pty 已编译好），运行时零构建工具。
# pnpm v10 起 deploy 要求工作区开 inject-workspace-packages，本仓没开 —— 显式 --legacy
#（与 scripts/electron-host-bundle.mjs 同一条路径）。
RUN --mount=type=cache,id=gw-pnpm,target=/pnpm/store \
    pnpm --filter @greywork/host-node deploy --prod --legacy /out

########## 3) 运行时（node:22-slim：宿主是 Node 程序；apt 只装 CLI 依赖） ##########
FROM node:22-bookworm-slim AS runtime
# git：git_* 命令走系统 git CLI；ca-certificates：出站 HTTPS（模型 / 通道）验证根证书。
# ACP agent 运行时（npx / python3 / uvx …）本镜像只带 node —— 其余按需在派生镜像里装，
# 并用 GREYWORK_AGENT_PROGRAMS 显式放行（白名单是冻结的，只信配置，不读 DB）。
#
# LibreOffice（writer + impress，够覆盖 docx/pptx/.doc/.ppt）：本仓「高保真(PDF)」预览的
# 转换引擎。用 --no-install-recommends 只装两个组件而非完整 libreoffice，缩镜像体积；
# soffice 在 /usr/bin，运行时 PATH 探测即可找到，无需 GREYWORK_SOFFICE_PATH。
# fonts-noto-cjk：中文文档转 PDF 才能正确嵌字，否则 CJK 文本缺字变成方框。
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git \
    libreoffice-writer libreoffice-impress fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
# 非 root 运行；挂载 /data 卷时注意宿主目录属主应为 uid=10001。
#
# /data 必须在镜像里就存在且属于运行用户：Docker 新建（匿名或命名）卷时会**继承镜像里
# 该路径的属主**，不预先建好就是 root:root，uid 10001 连库文件都建不出来 —— 症状是容器
# 启动即 `打开数据库失败: unable to open database file: /data/greywork.db`。
RUN useradd --system --create-home --home-dir /home/greywork --uid 10001 greywork \
    && mkdir -p /data \
    && chown greywork:greywork /data
COPY --from=server /out /app/host
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
    CMD ["node", "-e", "const p = (process.env.GREYWORK_BIND || '').split(':').pop() || 8787; fetch('http://127.0.0.1:' + p + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
# 无子命令 → 起服务；也可 `docker run … host-node hash-password` 生成密码哈希。
WORKDIR /app/host
ENTRYPOINT ["node", "dist/index.js"]
