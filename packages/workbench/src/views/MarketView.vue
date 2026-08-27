<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { getPluginMarket } from "../state/pluginMarket";
import { loadRemoteSkills, saveRemoteSkills, type RemoteSkillRecord } from "../state/remoteSkills";
import { Blocks, Plug, Search, Sparkles } from "lucide-vue-next";
import { Badge, Button, Dialog } from "../components/ui";
import {
  createBuiltinSources,
  createMcpRegistryClient,
  TauriSkillsTransport,
  toMcpServerManifest,
  type MarketSkillEntry,
  type McpRegistryEntry,
  type SkillSnapshot,
} from "@greywork/plugins";
import { desktopHomeDir } from "@greywork/acp";
import { useSettingsStore } from "../stores/settings";
import { persistRegisteredMcp, removeRegisteredMcp } from "../state/pluginMarket";

const pluginMarket = getPluginMarket();
const route = useRoute();
const settings = useSettingsStore();

/* ===== 远程技能市场（宿主代理；安装落盘工作区 .agents/skills/） ===== */
const transport = new TauriSkillsTransport();
const sources = createBuiltinSources(transport);
const activeSourceId = ref(sources[0]?.id ?? "");
const activeSource = computed(() => sources.find((source) => source.id === activeSourceId.value));

const remoteQuery = ref("");
const remoteResults = ref<MarketSkillEntry[]>([]);
const remoteLoading = ref(false);
const remoteError = ref("");
const remoteSearched = ref(false);
let remoteDebounce: ReturnType<typeof setTimeout> | null = null;

const remoteInstalled = ref<RemoteSkillRecord[]>(loadRemoteSkills());
function isRemoteInstalled(entry: MarketSkillEntry): boolean {
  return remoteInstalled.value.some((record) => record.ref === entry.ref);
}

const pendingInstall = ref<{ entry: MarketSkillEntry; snapshot: SkillSnapshot } | null>(null);
const installBusy = ref(false);
const installFeedback = ref("");

async function resolveWorkspace(): Promise<string> {
  const configured = settings.workspaceDir.trim();
  if (configured) return configured;
  const home = await desktopHomeDir();
  if (!home) throw new Error("无法解析工作区目录：请在设置中配置 workspaceDir");
  return home;
}

async function runRemoteSearch(query: string): Promise<void> {
  const source = activeSource.value;
  if (!source || !transport.available() || query.trim().length < 2) {
    remoteResults.value = [];
    remoteError.value = "";
    remoteSearched.value = false;
    return;
  }
  remoteLoading.value = true;
  remoteError.value = "";
  try {
    remoteResults.value = await source.search(query);
    remoteSearched.value = true;
  } catch (error) {
    remoteError.value = error instanceof Error ? error.message : String(error);
  } finally {
    remoteLoading.value = false;
  }
}

watch([remoteQuery, activeSourceId], ([query]) => {
  if (remoteDebounce) clearTimeout(remoteDebounce);
  remoteDebounce = setTimeout(() => void runRemoteSearch(query), 400);
});
onBeforeUnmount(() => {
  if (remoteDebounce) clearTimeout(remoteDebounce);
});

async function openInstallConfirm(entry: MarketSkillEntry): Promise<void> {
  installFeedback.value = "";
  try {
    const snapshot = await (activeSource.value as NonNullable<typeof activeSource.value>).download(entry);
    pendingInstall.value = { entry, snapshot };
  } catch (error) {
    installFeedback.value = `下载失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function confirmInstall(): Promise<void> {
  const pending = pendingInstall.value;
  if (!pending || installBusy.value) return;
  installBusy.value = true;
  try {
    const workspace = await resolveWorkspace();
    await transport.install(workspace, pending.entry.skillId, pending.snapshot.files);
    const record: RemoteSkillRecord = {
      sourceId: activeSourceId.value,
      ref: pending.entry.ref,
      skillId: pending.entry.skillId,
      name: pending.entry.name,
      installs: pending.entry.installs,
      hash: pending.snapshot.hash,
      files: pending.snapshot.files.map((file) => file.path),
      installedAt: Date.now(),
    };
    remoteInstalled.value = [...remoteInstalled.value.filter((item) => item.ref !== record.ref), record];
    saveRemoteSkills(remoteInstalled.value);
    installFeedback.value = `已安装到 ${workspace}/.agents/skills/${record.skillId}`;
    pendingInstall.value = null;
  } catch (error) {
    installFeedback.value = `安装失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    installBusy.value = false;
  }
}

async function uninstallRemote(record: RemoteSkillRecord): Promise<void> {
  try {
    const workspace = await resolveWorkspace();
    await transport.uninstall(workspace, record.skillId);
    remoteInstalled.value = remoteInstalled.value.filter((item) => item.ref !== record.ref);
    saveRemoteSkills(remoteInstalled.value);
  } catch (error) {
    installFeedback.value = `卸载失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

/* ===== 本地样例市场（原有行为保持） ===== */
const marketFilter = ref("全部");
const marketQuery = ref("");
const pluginDetailOpen = ref(false);

const marketCategories = ["全部", "Skill", "Extension", "MCP"];

function categoryOf(id: string): string {
  return id.startsWith("skill-") ? "Skill" : id.startsWith("ext-") ? "Extension" : "MCP";
}

interface MarketEntry {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  tags: string[];
  downloads: number;
  rating: number;
}

const marketEntries = computed<MarketEntry[]>(() =>
  pluginMarket.marketplace.map((manifest) => ({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author?.name ?? "Community",
    description: manifest.description ?? "",
    tags: manifest.tags ?? [],
    downloads: 1000,
    rating: 4.5,
  })),
);

const filteredMarket = computed(() => {
  const q = marketQuery.value.toLowerCase();
  return marketEntries.value.filter((item) => {
    if (marketFilter.value !== "全部" && categoryOf(item.id) !== marketFilter.value) return false;
    if (q && !(item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q))) return false;
    return true;
  });
});

// 路由可寻址：/p/:id/market?plugin=xxx 预选详情
const selectedPluginId = ref<string>(String(route.query.plugin ?? "skill-gis"));
watch(
  () => route.query.plugin,
  (plugin) => {
    if (typeof plugin === "string" && plugin) selectedPluginId.value = plugin;
  },
);

/* ===== MCP 官方注册表（浏览 + 一键登记；运行时连接属未来能力） ===== */
const mcpRegistry = createMcpRegistryClient();
const mcpQuery = ref("");
const mcpResults = ref<McpRegistryEntry[]>([]);
const mcpLoading = ref(false);
const mcpError = ref("");
const mcpFeedback = ref("");
let mcpDebounce: ReturnType<typeof setTimeout> | null = null;

async function runMcpSearch(query: string): Promise<void> {
  if (!mcpRegistry.available() || query.trim().length < 2) {
    mcpResults.value = [];
    mcpError.value = "";
    return;
  }
  mcpLoading.value = true;
  mcpError.value = "";
  try {
    mcpResults.value = await mcpRegistry.search(query, 20);
  } catch (error) {
    mcpError.value = error instanceof Error ? error.message : String(error);
  } finally {
    mcpLoading.value = false;
  }
}

watch(mcpQuery, (value) => {
  if (mcpDebounce) clearTimeout(mcpDebounce);
  mcpDebounce = setTimeout(() => void runMcpSearch(value), 400);
});

function isMcpRegistered(entry: McpRegistryEntry): boolean {
  return pluginMarket.installedIds().includes(
    `mcp-${entry.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56)}`,
  );
}

/** 浏览条目 → 转换为 McpServerManifest → 入市场并登记（stdio 命令由映射层固定生成）。 */
function registerMcp(entry: McpRegistryEntry): void {
  const manifest = toMcpServerManifest(entry);
  if (!manifest) {
    mcpFeedback.value = `暂不支持该条目的传输类型：${entry.name}`;
    return;
  }
  if (!pluginMarket.marketplace.some((item) => item.id === manifest.id)) {
    pluginMarket.marketplace.push(manifest);
  }
  pluginMarket.install(manifest.id);
  persistRegisteredMcp(manifest);
  const envTags = (manifest.tags ?? []).filter((tag) => tag.startsWith("env:"));
  mcpFeedback.value =
    `已登记 ${manifest.id}` + (envTags.length ? ` · 使用前需补环境变量：${envTags.map((tag) => tag.slice(4)).join(", ")}` : "");
}

function unregisterMcp(entry: McpRegistryEntry): void {
  const id = `mcp-${entry.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)}`;
  if (!pluginMarket.uninstall(id)) return;
  removeRegisteredMcp(id);
  const index = pluginMarket.marketplace.findIndex((item) => item.id === id);
  if (index >= 0) pluginMarket.marketplace.splice(index, 1);
}

const selectedPlugin = computed(() => marketEntries.value.find((entry) => entry.id === selectedPluginId.value) ?? marketEntries.value[0]);

function togglePlugin(id: string): void {
  if (pluginMarket.installedIds().includes(id)) pluginMarket.uninstall(id);
  else pluginMarket.install(id);
}
</script>

<template>
  <section class="view">
    <div class="view__head">
      <div>
        <p class="view__eyebrow">PLUGIN MARKET</p>
        <h1 class="view__title">插件市场</h1>
        <p class="view__sub">Skill · Extension · MCP，一切皆插件。</p>
      </div>
    </div>
    <div class="market-toolbar">
      <div class="hero__pillbar">
        <button v-for="c in marketCategories" :key="c" class="hero__pill" :class="{ active: marketFilter === c }" @click="marketFilter = c">
          {{ c }}
        </button>
      </div>
      <div class="market-search">
        <Search class="size-3.5" /><input
          v-model="marketQuery"
          placeholder="搜索插件…"
          class="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
    </div>
    <div class="market-remote">
      <div class="hero__pillbar">
        <button
          v-for="source in sources"
          :key="source.id"
          class="hero__pill"
          :class="{ active: activeSourceId === source.id }"
          :title="source.description"
          @click="activeSourceId = source.id"
        >
          {{ source.label }}
        </button>
        <span v-if="!transport.available()" class="chip">桌面端可用 · Web 无宿主通道</span>
      </div>
      <div class="market-search">
        <Search class="size-3.5" /><input
          v-model="remoteQuery"
          placeholder="搜索远程技能（如 tdd / frontend-design / lark）…"
          class="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
    </div>
    <div v-if="remoteQuery.trim().length >= 2" class="market-grid">
      <div class="market-list">
        <p v-if="remoteLoading" class="footnote">搜索中…</p>
        <p v-else-if="remoteError" class="footnote">{{ remoteError }}</p>
        <p v-else-if="!remoteResults.length && remoteSearched" class="footnote">没有匹配的远程技能。</p>
        <div v-for="entry in remoteResults" :key="entry.ref" class="plugin-card">
          <div class="plugin-card__head">
            <span class="plugin-card__icon" data-kind="skill"><Sparkles class="size-4" /></span>
            <div>
              <strong>{{ entry.name }}</strong
              ><span>{{ entry.source }}</span>
            </div>
            <Badge variant="info">{{ entry.downloadable ? "可安装" : "索引" }}</Badge>
          </div>
          <p class="plugin-card__desc">{{ entry.ref }}</p>
          <div class="plugin-card__foot">
            <span>⬇ {{ entry.installs.toLocaleString() }}</span>
            <Button v-if="entry.downloadable && !isRemoteInstalled(entry)" size="sm" @click.stop="openInstallConfirm(entry)"
              >获取并安装</Button
            >
            <Badge v-else-if="entry.downloadable" variant="success">已安装</Badge>
          </div>
        </div>
      </div>
      <div class="panel panel--detail">
        <div class="panel__head">
          <span class="panel__title">已安装的远程技能</span>
          <span class="panel__meta">{{ remoteInstalled.length }}</span>
        </div>
        <p class="footnote">安装位置：工作区 .agents/skills/ —— 外部 ACP agent（opencode / claude-code 等）自动识别。</p>
        <div v-for="record in remoteInstalled" :key="record.ref" class="plugin-card">
          <div class="plugin-card__head">
            <span class="plugin-card__icon" data-kind="skill"><Sparkles class="size-4" /></span>
            <div>
              <strong>{{ record.name }}</strong
              ><span>{{ record.files.length }} 个文件</span>
            </div>
          </div>
          <div class="plugin-card__foot">
            <Button variant="ghost" size="sm" @click.stop="uninstallRemote(record)">卸载</Button>
          </div>
        </div>
      </div>
    </div>

    <div class="market-remote">
      <div class="chips">
        <span class="chip chip--on">MCP Registry · 官方</span>
        <span v-if="!mcpRegistry.available()" class="chip">桌面端可用</span>
      </div>
      <div class="market-search">
        <Plug class="size-3.5" /><input
          v-model="mcpQuery"
          placeholder="搜索官方 MCP 服务器（如 github / filesystem / sqlite）…"
          class="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
    </div>
    <div v-if="mcpQuery.trim().length >= 2" class="market-grid">
      <div class="market-list">
        <p v-if="mcpLoading" class="footnote">搜索中…</p>
        <p v-else-if="mcpError" class="footnote">{{ mcpError }}</p>
        <p v-else-if="!mcpResults.length" class="footnote">没有匹配的 MCP 服务器。</p>
        <div v-for="entry in mcpResults" :key="entry.name" class="plugin-card">
          <div class="plugin-card__head">
            <span class="plugin-card__icon" data-kind="mcp"><Plug class="size-4" /></span>
            <div>
              <strong>{{ entry.title || entry.name }}</strong
              ><span>{{ entry.name }}</span>
            </div>
            <Badge variant="info">MCP</Badge>
          </div>
          <p class="plugin-card__desc">{{ entry.description || "（无描述）" }}</p>
          <div class="plugin-card__foot">
            <span
              >{{ entry.remotes.length ? `远程 × ${entry.remotes.length}` : "" }}
              {{ entry.packages.length ? `包 × ${entry.packages.length}` : "" }}</span
            >
            <Button v-if="!isMcpRegistered(entry)" size="sm" @click.stop="registerMcp(entry)">登记为插件</Button>
            <Button v-else variant="ghost" size="sm" @click.stop="unregisterMcp(entry)">取消登记</Button>
          </div>
        </div>
      </div>
    </div>

    <Dialog
      :open="pendingInstall !== null"
      content-class="w-[min(560px,calc(100vw-48px))]"
      @update:open="if (!$event) pendingInstall = null;"
    >
      <template v-if="pendingInstall">
        <p class="mb-2 text-sm font-semibold">确认安装 · {{ pendingInstall.entry.name }}</p>
        <p class="footnote mb-1">
          来源 {{ pendingInstall.entry.source }} · {{ pendingInstall.snapshot.files.length }} 个文件 · hash
          {{ pendingInstall.snapshot.hash.slice(0, 12) || "-" }}
        </p>
        <p class="footnote mb-2">将写入工作区 .agents/skills/{{ pendingInstall.entry.skillId }}/ ，外部 agent 会自动加载其中的指令。</p>
        <ul class="mb-3 max-h-48 overflow-y-auto rounded border border-line bg-black/20 p-2 font-mono text-[11px] leading-5">
          <li v-for="file in pendingInstall.snapshot.files" :key="file.path">{{ file.path }}（{{ file.contents.length }} B）</li>
        </ul>
        <div class="flex gap-2">
          <Button size="sm" :disabled="installBusy" @click="confirmInstall">{{ installBusy ? "安装中…" : "确认安装" }}</Button>
          <Button variant="ghost" size="sm" @click="pendingInstall = null">取消</Button>
        </div>
      </template>
    </Dialog>
    <p v-if="installFeedback" class="footnote mt-2">{{ installFeedback }}</p>
    <div class="market-grid">
      <div class="market-list">
        <div
          v-for="p in filteredMarket"
          :key="p.id"
          class="plugin-card"
          :class="{ active: selectedPluginId === p.id }"
          @click="selectedPluginId = p.id"
        >
          <div class="plugin-card__head">
            <span class="plugin-card__icon" :data-kind="categoryOf(p.id).toLowerCase()"
              ><Sparkles v-if="p.id.startsWith('skill-')" class="size-4" /><Blocks
                v-else-if="p.id.startsWith('ext-')"
                class="size-4" /><Plug v-else class="size-4"
            /></span>
            <div>
              <strong>{{ p.name }}</strong
              ><span>{{ p.author }} · v{{ p.version }}</span>
            </div>
            <Badge variant="info">{{ categoryOf(p.id) }}</Badge>
          </div>
          <p class="plugin-card__desc">{{ p.description }}</p>
          <div class="plugin-card__foot">
            <span>⬇ {{ p.downloads.toLocaleString() }}</span>
            <span>★ {{ p.rating.toFixed(1) }}</span>
            <Button
              variant="ghost"
              size="sm"
              @click.stop="
                pluginDetailOpen = true;
                selectedPluginId = p.id;
              "
              >详情</Button
            >
            <Button v-if="!pluginMarket.installedIds().includes(p.id)" size="sm" @click.stop="togglePlugin(p.id)">安装</Button>
            <Button v-else variant="ghost" size="sm" @click.stop="togglePlugin(p.id)">卸载</Button>
          </div>
        </div>
      </div>
      <div class="panel panel--detail">
        <div class="panel__head">
          <span class="panel__title">{{ selectedPlugin?.name }}</span
          ><span class="panel__meta">{{ selectedPlugin?.version }}</span>
        </div>
        <p class="detail-desc">{{ selectedPlugin?.description }}</p>
        <div class="chips">
          <span v-for="tag in selectedPlugin?.tags" :key="tag" class="chip">{{ tag }}</span>
        </div>
        <div class="detail-stats">
          <div>
            <span>下载</span><strong>{{ selectedPlugin?.downloads.toLocaleString() }}</strong>
          </div>
          <div>
            <span>评分</span><strong>{{ selectedPlugin?.rating.toFixed(1) }}</strong>
          </div>
        </div>
        <Button
          v-if="selectedPlugin && !pluginMarket.installedIds().includes(selectedPlugin.id)"
          class="mt-4 w-full"
          @click="togglePlugin(selectedPlugin.id)"
        >
          安装到当前会话
        </Button>
        <Button v-else variant="secondary" class="mt-4 w-full" disabled>已在当前会话中</Button>
      </div>
    </div>

    <Dialog :open="pluginDetailOpen" content-class="w-[min(560px,calc(100vw-48px))]" @update:open="pluginDetailOpen = $event">
      <p class="mb-2 text-sm font-semibold">{{ selectedPlugin?.name ?? "" }}</p>
      <p class="detail-desc">{{ selectedPlugin?.description }}</p>
      <div class="chips">
        <span v-for="tag in selectedPlugin?.tags" :key="tag" class="chip">{{ tag }}</span>
      </div>
      <div class="detail-stats">
        <div>
          <span>下载</span><strong>{{ selectedPlugin?.downloads.toLocaleString() }}</strong>
        </div>
        <div>
          <span>评分</span><strong>{{ selectedPlugin?.rating.toFixed(1) }}</strong>
        </div>
      </div>
      <Button
        v-if="selectedPlugin && !pluginMarket.installedIds().includes(selectedPlugin.id)"
        class="mt-4 w-full"
        @click="togglePlugin(selectedPlugin.id)"
      >
        安装到当前会话
      </Button>
      <Button v-else variant="destructive" class="mt-4 w-full" @click="selectedPlugin && togglePlugin(selectedPlugin.id)">卸载</Button>
    </Dialog>
  </section>
</template>
