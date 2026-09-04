<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { setLocale } from "../i18n";
import { systemBackend, type SysInfo } from "../lib/system-backend";
import { MCP_SKIP_REASONS, MCP_TRANSPORT_LABELS } from "../lib/mcp-labels";
import { useAgentStore } from "../stores/agent";
import { useChatStore } from "../stores/chat";
import {
  RUN_MODES,
  SANDBOX_MODES,
  PERMISSION_TIERS,
  recommendedSandboxMode,
  useSettingsStore,
  type McpServerEntry,
} from "../stores/settings";
import Icon from "../components/Icon.vue";
import StorageSettings from "../components/StorageSettings.vue";

/**
 * 设置内容区：按 /settings/:section 分派子面板。导航在 SettingsSider（左侧栏）。
 * 字段直接写 settings store，变更即持久化。
 */
const route = useRoute();
const settings = useSettingsStore();
const agent = useAgentStore();
const chatStore = useChatStore();

const section = computed(() => String(route.params.section ?? "agent"));

const sectionMeta = [
  { key: "agent", title: "Agent", desc: "模型供应商与默认后端" },
  { key: "assistant", title: "助手", desc: "会话与助手默认行为" },
  { key: "appearance", title: "外观", desc: "主题与语言" },
  { key: "mode", title: "运行模式", desc: "执行档位与权限策略" },
  { key: "system", title: "系统", desc: "环境信息与沙盒" },
  { key: "mcp", title: "MCP", desc: "外部工具服务器：声明给 agent，由 agent 连接" },
  { key: "storage", title: "存储", desc: "会话落盘与远端同步" },
  { key: "team", title: "团队", desc: "成员与协作空间" },
] as const;

const meta = computed(() => sectionMeta.find((item) => item.key === section.value) ?? sectionMeta[0]);

const activeProvider = computed(() => settings.modelProviders.find((provider) => provider.id === settings.selectedModelProviderId));

function applyLocale(locale: "zh-CN" | "en-US"): void {
  settings.locale = locale;
  setLocale(locale);
  settings.persist();
}

/** 系统诊断快照（桌面态从 Rust 拉取；浏览器态 null）。 */
const sysInfo = ref<SysInfo | null>(null);
const sysInfoFailed = ref(false);

onMounted(() => {
  if (!systemBackend.active()) return;
  void systemBackend
    .info()
    .then((info) => {
      sysInfo.value = info;
    })
    .catch((error: unknown) => {
      sysInfoFailed.value = true;
      console.error("[settings] 系统信息拉取失败", error);
    });
});

/** 权限三档中文名与说明（grey 外壳直接写字面量，不走 i18n key）。 */
const permTierLabels: Record<string, string> = {
  "read-only": "只读",
  workspace: "工作区",
  full: "完全访问",
};

const permTierDescs: Record<string, string> = {
  "read-only": "禁止一切写入与执行类操作，仅允许读取",
  workspace: "自动执行，写入仅限当前工作区文件夹内",
  full: "可读写任意路径，不设工作区边界",
};

const sandboxLabels: Record<string, string> = { off: "关闭", fs: "文件系统隔离", full: "隔离 + 网络" };

const sandboxDescs: Record<string, string> = {
  off: "直启 agent 进程，不做 OS 级隔离（进程边界 + 宿主权限守卫仍在）。",
  fs: "bwrap 包裹：系统路径只读、工作区可写、/tmp 隔离、网络关闭。需系统安装 bwrap。",
  full: "同文件系统隔离，但放行网络（agent 可联网搜索 / MCP）。",
};

/** 与当前权限档位配套的沙盒档位；不一致时给出联动入口。 */
const suggestedSandbox = computed(() => recommendedSandboxMode(settings.permissionTier));

function applyPermissionTier(tier: (typeof PERMISSION_TIERS)[number]["value"]): void {
  settings.permissionTier = tier;
  settings.persist();
}

function applySandboxMode(mode: (typeof SANDBOX_MODES)[number]["value"]): void {
  settings.sandboxMode = mode;
  settings.persist();
}

// ---------- MCP ----------

/** 新增表单草稿。transport 决定填 url 还是 command。 */
const mcpDraft = ref({ name: "", transport: "http" as McpServerEntry["transport"], url: "", command: "", args: "" });
const mcpDraftError = ref<string | null>(null);
/** 每台服务器最近一次「测试连接」的结果（成功列工具，失败给原因）。 */
const mcpProbes = ref<Record<string, { server?: string; tools?: string[]; error?: string }>>({});
const mcpProbing = ref<string | null>(null);

function addMcpServer(): void {
  const name = mcpDraft.value.name.trim();
  if (!name) {
    mcpDraftError.value = "请先填服务器名";
    return;
  }
  const transport = mcpDraft.value.transport;
  const url = mcpDraft.value.url.trim();
  const command = mcpDraft.value.command.trim();
  if (transport === "stdio" ? !command : !url) {
    mcpDraftError.value = transport === "stdio" ? "stdio 需要可执行文件绝对路径" : "远程传输需要 URL";
    return;
  }
  mcpDraftError.value = null;
  const args = mcpDraft.value.args
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);
  settings.upsertMcpServer({
    id: `mcp-${Date.now().toString(36)}`,
    name,
    transport,
    enabled: true,
    ...(transport === "stdio" ? { command, args } : { url }),
  });
  mcpDraft.value = { name: "", transport, url: "", command: "", args: "" };
}

async function testMcpServer(entry: McpServerEntry): Promise<void> {
  mcpProbing.value = entry.id;
  const { id: _id, enabled: _enabled, ...config } = entry;
  const { report, error } = await agent.probeMcpServer(config);
  mcpProbing.value = null;
  mcpProbes.value = {
    ...mcpProbes.value,
    [entry.id]: error
      ? { error }
      : {
          server: report?.serverName ? `${report.serverName} ${report.serverVersion ?? ""}`.trim() : undefined,
          tools: report?.tools.map((tool) => tool.name) ?? [],
        },
  };
}
</script>

<template>
  <section class="mx-auto min-h-0 w-full max-w-[720px] overflow-y-auto px-4 py-6 sm:px-6">
    <header class="mb-6">
      <h1 class="font-display text-[20px] font-bold tracking-tight text-foreground">{{ meta.title }}</h1>
      <p class="mt-1 text-[12px] text-dim2">{{ meta.desc }}</p>
    </header>

    <div class="flex flex-col gap-4">
      <template v-if="section === 'agent'">
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">默认模型供应商</div>
          <div class="flex flex-col gap-1.5">
            <button
              v-for="provider in settings.modelProviders"
              :key="provider.id"
              class="flex cursor-pointer items-center gap-2.5 rounded-[10px] border px-3 py-2 text-left transition-colors"
              :class="provider.id === settings.selectedModelProviderId ? 'border-line-2 bg-panel-2' : 'border-transparent hover:bg-panel-2'"
              @click="settings.selectedModelProviderId = provider.id"
            >
              <Icon :name="provider.enabled ? 'check-one' : 'close-one'" :size="14" class="text-dim" />
              <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">{{ provider.name }}</span>
              <span class="font-mono text-[11px] text-dim2">{{ provider.model }}</span>
            </button>
          </div>
        </div>
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-1.5 text-[13px] font-medium text-foreground">推理等级</div>
          <div class="text-[11px] text-dim2">当前 {{ activeProvider?.reasoningEffort ?? "auto" }}</div>
        </div>
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">ACP 后端（聊天 / 自动执行）</div>
          <div class="flex flex-col gap-1.5">
            <label
              v-for="provider in agent.agentProviders"
              :key="provider.id"
              class="flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-transparent px-3 py-2 transition-colors hover:bg-panel-2"
            >
              <input
                type="checkbox"
                class="size-4 cursor-pointer accent-[var(--accent)]"
                :checked="provider.enabled"
                @change="void agent.setAgentProviderEnabled(provider.id, ($event.target as HTMLInputElement).checked)"
              />
              <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">{{ provider.name }}</span>
              <span class="max-w-[40%] truncate font-mono text-[11px] text-dim2">{{ provider.command }}</span>
            </label>
          </div>
          <p class="mt-2 text-[11px] text-dim2">启用后出现在发送条上方的后端选择胶囊；停用当前后端会自动切回 Local。</p>
        </div>
      </template>

      <template v-else-if="section === 'assistant'">
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <label class="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span class="block text-[13px] font-medium text-foreground">Plan 模式</span>
              <span class="block text-[11px] text-dim2">发送前先出计划，确认后再执行</span>
            </span>
            <input
              v-model="settings.planMode"
              type="checkbox"
              class="size-4 cursor-pointer accent-[var(--accent)]"
              :aria-label="'Plan 模式'"
            />
          </label>
        </div>
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <label class="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span class="block text-[13px] font-medium text-foreground">速度加成</span>
              <span class="block text-[11px] text-dim2">加速 mock 管线响应（演示用）</span>
            </span>
            <input
              v-model="chatStore.speedBoost"
              type="checkbox"
              class="size-4 cursor-pointer accent-[var(--accent)]"
              :aria-label="'速度加成'"
            />
          </label>
        </div>
      </template>

      <template v-else-if="section === 'appearance'">
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">主题</div>
          <div class="grid grid-cols-3 gap-2">
            <button
              v-for="mode in ['dark', 'light', 'system'] as const"
              :key="mode"
              class="flex cursor-pointer flex-col items-center gap-2 rounded-[10px] border border-line px-3 py-3 transition-colors"
              :class="settings.theme === mode ? 'bg-panel-2' : 'hover:bg-panel-2'"
              :aria-pressed="settings.theme === mode"
              @click="
                settings.theme = mode;
                settings.persist();
              "
            >
              <Icon :name="mode === 'dark' ? 'moon' : mode === 'light' ? 'sun' : 'refresh'" :size="16" class="text-dim" />
              <span class="text-[12px] text-foreground">{{ mode === "dark" ? "深色" : mode === "light" ? "浅色" : "跟随系统" }}</span>
            </button>
          </div>
        </div>
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">语言</div>
          <div class="flex gap-2">
            <button
              v-for="locale in ['zh-CN', 'en-US'] as const"
              :key="locale"
              class="flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-line px-3 py-1.5 text-[12px] transition-colors"
              :class="settings.locale === locale ? 'bg-panel-2 text-foreground' : 'text-dim hover:bg-panel-2'"
              @click="applyLocale(locale)"
            >
              {{ locale === "zh-CN" ? "中文" : "English" }}
            </button>
          </div>
        </div>
      </template>

      <template v-else-if="section === 'mode'">
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">运行模式</div>
          <div class="flex flex-col gap-1.5">
            <button
              v-for="mode in RUN_MODES"
              :key="mode.value"
              class="flex cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-panel-2"
              :class="settings.runMode === mode.value ? 'bg-panel-2' : ''"
              @click="settings.runMode = mode.value"
            >
              <span class="text-[13px] text-foreground">{{ mode.label }}</span>
              <span class="text-[11px] text-dim2">{{ mode.hint }}</span>
            </button>
          </div>
        </div>
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">权限档位</div>
          <div class="flex gap-2">
            <button
              v-for="tier in PERMISSION_TIERS"
              :key="tier.value"
              class="flex flex-1 cursor-pointer flex-col gap-1 rounded-[10px] border border-line px-3 py-2.5 text-left transition-colors"
              :class="settings.permissionTier === tier.value ? 'bg-panel-2' : 'hover:bg-panel-2'"
              :aria-pressed="settings.permissionTier === tier.value"
              @click="applyPermissionTier(tier.value)"
            >
              <span class="text-[12px] font-medium text-foreground">{{ permTierLabels[tier.value] }}</span>
              <span class="text-[11px] leading-[1.5] text-dim2">{{ permTierDescs[tier.value] }}</span>
            </button>
          </div>
          <p v-if="settings.permissionTier === 'full'" class="mt-2 text-[11px] text-amber-400">
            完全访问不设工作区边界：agent 可读写任意路径。建议配合沙盒「{{
              sandboxLabels[suggestedSandbox]
            }}」，或用下面的临时只读跑高风险回合。
          </p>
          <label class="mt-3 flex cursor-pointer items-center justify-between gap-3 border-t border-line-2 pt-3">
            <span>
              <span class="block text-[13px] font-medium text-foreground">临时只读</span>
              <span class="block text-[11px] text-dim2">在途会话立即降为只读，跑完再关掉回到基线档位（不持久化）</span>
            </span>
            <input
              v-model="settings.tempReadOnly"
              data-testid="temp-readonly-toggle"
              type="checkbox"
              class="size-4 cursor-pointer accent-[var(--accent)]"
              aria-label="临时只读"
              @change="void agent.applyPermissionTier()"
            />
          </label>
          <p class="mt-2 text-[11px] text-dim">
            当前生效档位：{{ permTierLabels[settings.effectivePermissionTier] }}
            <span v-if="settings.tempReadOnly">（基线 {{ permTierLabels[settings.permissionTier] }} 已临时降级）</span>
          </p>
        </div>
      </template>

      <template v-else-if="section === 'system'">
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">关于</div>
          <div v-if="sysInfo" class="flex flex-col gap-1 font-mono text-[11px] text-dim2">
            <div class="flex justify-between">
              <span>版本</span><span class="text-foreground">{{ sysInfo.version }}</span>
            </div>
            <div class="flex justify-between">
              <span>数据 schema</span><span class="text-foreground">v{{ sysInfo.schemaVersion }}</span>
            </div>
            <div class="flex justify-between">
              <span>活跃 ACP 后端</span><span class="text-foreground">{{ sysInfo.activeAgents }}</span>
            </div>
            <div class="flex justify-between">
              <span>宿主 OS</span><span class="text-foreground">{{ sysInfo.os }}</span>
            </div>
            <div v-if="sysInfo.logDir" class="mt-1 flex flex-col gap-0.5">
              <span>日志目录</span>
              <span class="break-all text-dim">{{ sysInfo.logDir }}</span>
            </div>
          </div>
          <div v-else class="text-[11px] text-dim2">
            {{ sysInfoFailed ? "系统信息拉取失败（见控制台日志）" : "浏览器预览：无宿主诊断面。" }}
          </div>
        </div>
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-1 text-[13px] font-medium text-foreground">沙盒</div>
          <p class="mb-3 text-[11px] leading-[1.6] text-dim2">
            沙盒档位与权限档位是两条独立边界：权限三档是宿主在 ACP 工具调用层的<b class="font-medium text-dim">授权</b>判定（越界直接拒），
            沙盒档位是 bwrap 在 <b class="font-medium text-dim">OS 层</b>的隔离（进程连看都看不到）。两者互不替代 —— 「完全访问 +
            沙盒关闭」等于没有任何边界。
          </p>
          <div class="flex flex-col gap-1.5">
            <button
              v-for="mode in SANDBOX_MODES"
              :key="mode.value"
              class="flex cursor-pointer items-start justify-between gap-3 rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-panel-2"
              :class="settings.sandboxMode === mode.value ? 'bg-panel-2' : ''"
              :aria-pressed="settings.sandboxMode === mode.value"
              @click="applySandboxMode(mode.value)"
            >
              <span class="min-w-0">
                <span class="block text-[13px] text-foreground">{{ sandboxLabels[mode.value] }}</span>
                <span class="block text-[11px] leading-[1.5] text-dim2">{{ sandboxDescs[mode.value] }}</span>
              </span>
              <Icon :name="settings.sandboxMode === mode.value ? 'check-one' : 'close-one'" :size="14" class="mt-0.5 shrink-0 text-dim" />
            </button>
          </div>
          <div v-if="settings.sandboxMode !== suggestedSandbox" class="mt-3 flex items-center gap-2 border-t border-line-2 pt-3">
            <span class="min-w-0 flex-1 text-[11px] text-dim">
              当前权限档位「{{ permTierLabels[settings.permissionTier] }}」建议沙盒「{{ sandboxLabels[suggestedSandbox] }}」
            </span>
            <button
              type="button"
              data-testid="sandbox-recommend"
              class="flex h-7 shrink-0 cursor-pointer items-center rounded-[8px] border border-line-2 bg-panel-2 px-3 text-[12px] text-foreground transition-colors hover:border-cyan"
              @click="applySandboxMode(suggestedSandbox)"
            >
              按权限档位联动
            </button>
          </div>
        </div>
      </template>

      <template v-else-if="section === 'mcp'">
        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-1 text-[13px] font-medium text-foreground">MCP 服务器</div>
          <p class="mb-3 text-[11px] leading-relaxed text-dim2">
            启用的服务器会在建会话时声明给 agent，由 <b>agent 自己连接</b>并把工具并入它的工具面；宿主不代理工具调用。 HTTP / SSE 需要后端在
            initialize 时声明对应能力，不支持会被跳过并在下方说明原因；stdio 所有后端都必须支持。
          </p>

          <div v-if="settings.mcpServers.length === 0" class="text-[12px] text-dim2">还没有声明任何 MCP 服务器。</div>
          <div v-else class="flex flex-col gap-2">
            <div v-for="entry in settings.mcpServers" :key="entry.id" class="rounded-[10px] bg-panel-2 p-2.5">
              <div class="flex items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-[12px] text-foreground">{{ entry.name }}</span>
                <span class="shrink-0 rounded-full border border-line px-1.5 text-[10px] text-dim2">
                  {{ MCP_TRANSPORT_LABELS[entry.transport] ?? entry.transport }}
                </span>
                <label class="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-dim">
                  <input
                    type="checkbox"
                    :checked="entry.enabled"
                    @change="settings.setMcpServerEnabled(entry.id, ($event.target as HTMLInputElement).checked)"
                  />
                  启用
                </label>
              </div>
              <div class="mt-1 truncate font-mono text-[11px] text-dim2">
                {{ entry.transport === "stdio" ? [entry.command, ...(entry.args ?? [])].join(" ") : entry.url }}
              </div>
              <div class="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  class="rounded-[8px] border border-line px-2 py-1 text-[11px] text-dim transition-colors hover:text-foreground disabled:opacity-50"
                  :disabled="mcpProbing === entry.id"
                  @click="testMcpServer(entry)"
                >
                  {{ mcpProbing === entry.id ? "连接中…" : "测试连接" }}
                </button>
                <button
                  type="button"
                  class="rounded-[8px] border border-line px-2 py-1 text-[11px] text-dim transition-colors hover:text-destructive"
                  @click="settings.removeMcpServer(entry.id)"
                >
                  删除
                </button>
              </div>
              <p v-if="mcpProbes[entry.id]?.error" class="mt-1.5 text-[11px] text-destructive">
                {{ mcpProbes[entry.id]?.error }}
              </p>
              <p v-else-if="mcpProbes[entry.id]" class="mt-1.5 text-[11px] text-dim">
                {{ mcpProbes[entry.id]?.server ?? "已连接" }} · 工具 {{ mcpProbes[entry.id]?.tools?.length ?? 0 }}：
                {{ (mcpProbes[entry.id]?.tools ?? []).join("、") }}
              </p>
            </div>
          </div>
        </div>

        <div class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-3 text-[13px] font-medium text-foreground">添加服务器</div>
          <div class="flex flex-col gap-1.5">
            <input
              v-model="mcpDraft.name"
              class="rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
              placeholder="名称（agent 会看到这个名字）"
            />
            <select
              v-model="mcpDraft.transport"
              class="rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-accent"
            >
              <option value="http">HTTP（streamable）</option>
              <option value="sse">SSE</option>
              <option value="stdio">stdio（本地进程）</option>
            </select>
            <input
              v-if="mcpDraft.transport !== 'stdio'"
              v-model="mcpDraft.url"
              class="rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
              placeholder="https://mcp.deepwiki.com/mcp"
            />
            <template v-else>
              <input
                v-model="mcpDraft.command"
                class="rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
                placeholder="/usr/bin/npx（可执行文件绝对路径）"
              />
              <input
                v-model="mcpDraft.args"
                class="rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
                placeholder="参数，空格分隔"
              />
            </template>
            <button
              type="button"
              class="self-start rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink"
              @click="addMcpServer"
            >
              添加
            </button>
            <p v-if="mcpDraftError" class="text-[11px] text-destructive">{{ mcpDraftError }}</p>
          </div>
        </div>

        <div v-if="agent.acpMcpServers.length > 0 || agent.acpMcpSkipped.length > 0" class="rounded-[14px] border border-line bg-panel p-4">
          <div class="mb-2 text-[13px] font-medium text-foreground">上次建会话的声明结果</div>
          <p v-if="agent.acpMcpServers.length > 0" class="text-[11px] text-dim">已声明：{{ agent.acpMcpServers.join("、") }}</p>
          <p v-for="skip in agent.acpMcpSkipped" :key="skip.name" class="text-[11px] text-destructive">
            已跳过 {{ skip.name }}：{{ MCP_SKIP_REASONS[skip.reason] ?? skip.reason }}
          </p>
        </div>
      </template>

      <template v-else-if="section === 'storage'">
        <StorageSettings />
      </template>

      <template v-else-if="section === 'team'">
        <div class="rounded-[14px] border border-line bg-panel p-4 text-[12px] text-dim2">团队协作能力接入中。</div>
      </template>
    </div>
  </section>
</template>
