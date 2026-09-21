<script setup lang="ts">
/**
 * ACP 后端图标轨道：初始只显示图标，点击项独占文字展开，其余保持收起。
 * 宽度不足时当前展开项始终留在主轨道，其他项收进「…」菜单。
 *
 * 展开宽度按内容撑开（不再写死 156px）：图标槽固定 30px，名字容器走
 * `grid-template-columns: 0fr ↔ 1fr` —— fr 过渡把轨道宽度从 0 拉到内容的
 * max-content，所以短名字（Codex）不会留一大截空白，长名字（GitHub Copilot CLI）
 * 也不必靠截断凑数。名字常驻 DOM（只是被收成 0 宽），展开状态由 `data-expanded` 表达。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { type AgentProviderConfig, REASONING_EFFORTS, type ReasoningEffort } from "@greywork/shell";
import { useAgentStore } from "@/stores/agent";
import { useSettingsStore } from "@/stores/settings";
import { localReasoningOverride, resolveLocalEffort } from "@/stores/chat-llm";
import AgentProviderIcon from "@/features/conversation/AgentProviderIcon.vue";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const agent = useAgentStore();
const settings = useSettingsStore();
const { t } = useI18n();

const acpOptions = computed<AgentProviderConfig[]>(() => agent.agentProviders);
const selected = computed(() => (agent.routeToAcp ? agent.selectedProviderId : null));
const connectError = ref<string | null>(null);

/** 展开只表达用户最近点击的选择；不从持久化路由初始化，保证首屏全部仅图标。 */
const expandedChoice = ref<string | null>(null);
const railEl = ref<HTMLElement | null>(null);
const railWidth = ref(0);
const overflowOpen = ref(false);

const TIER_LABELS: Record<string, string> = { "read-only": "只读", workspace: "工作区", full: "完全访问" };
const COLLAPSED_SLOT_PX = 38;
const EXPANDED_SLOT_PX = 162;
const OVERFLOW_SLOT_PX = 38;
const FALLBACK_RAIL_WIDTH_PX = 304;

/**
 * 主轨道容量使用保守固定槽位计算：收起项 32px + 6px gap；展开项按最坏情况留 162px + gap。
 * 展开宽度本身是按内容撑开的（见文件头），但名字容器的 max-w-[110px] 封了顶，
 * 于是展开项实际宽度 ≤ 30(图标槽) + 110(名字上限) + 10(右内边距) + 2(边框) = 152px，
 * 预算取 162 仍覆盖得住 —— 所以点开一项不会挤掉别的可见项，可见项数量不跳变。
 */
const visibleCapacity = computed(() => {
  const width = railWidth.value > 0 ? railWidth.value : FALLBACK_RAIL_WIDTH_PX;
  const expandedAcp = expandedChoice.value !== null && expandedChoice.value !== "local";
  const reserved = OVERFLOW_SLOT_PX + EXPANDED_SLOT_PX - (expandedAcp ? 0 : COLLAPSED_SLOT_PX);
  const collapsed = Math.floor(Math.max(0, width - reserved) / COLLAPSED_SLOT_PX);
  return Math.max(1, collapsed + (expandedAcp ? 1 : 0));
});

/** 当前展开项必须可见；超出首屏容量时替换最后一个普通项，并保持注册表原顺序。 */
const visibleAcpOptions = computed(() => {
  const capacity = Math.min(visibleCapacity.value, acpOptions.value.length);
  const expandedId = expandedChoice.value;
  const initial = acpOptions.value.slice(0, capacity);
  if (!expandedId || expandedId === "local" || initial.some((provider) => provider.id === expandedId)) return initial;
  const visibleIds = new Set(initial.slice(0, Math.max(0, capacity - 1)).map((provider) => provider.id));
  visibleIds.add(expandedId);
  return acpOptions.value.filter((provider) => visibleIds.has(provider.id));
});

const overflowAcpOptions = computed(() => {
  const visibleIds = new Set(visibleAcpOptions.value.map((provider) => provider.id));
  return acpOptions.value.filter((provider) => !visibleIds.has(provider.id));
});

function providerHint(provider: AgentProviderConfig): string {
  const installed = agent.providerInstalled(provider);
  return installed === null ? provider.name : `${provider.name} · ${agent.providerInstallLabel(provider)}`;
}

function selectLocal(): void {
  expandedChoice.value = "local";
  overflowOpen.value = false;
  connectError.value = null;
  void agent.switchToLocalLlm();
}

async function selectAcp(id: string): Promise<void> {
  expandedChoice.value = id;
  overflowOpen.value = false;
  connectError.value = null;
  const provider = agent.agentProviders.find((candidate) => candidate.id === id);
  if (provider && !provider.enabled) await agent.setAgentProviderEnabled(id, true);
  if (id === agent.selectedProviderId && agent.routeToAcp && agent.acpConnected) return;
  connectError.value = await agent.activateAcpProvider(id);
}

async function toggleTempReadOnly(on: boolean): Promise<void> {
  connectError.value = await agent.setTempReadOnly(on);
}

// ---------- Local 路由的模型 / 思考强度选择器 ----------

/** 可选的 Local 供应商：启用且 baseUrl/model 齐全（与 chat-llm 的可用判据一致）。 */
const localProviders = computed(() =>
  settings.modelProviders.filter((provider) => provider.enabled && !!provider.baseUrl?.trim() && !!provider.model.trim()),
);

/** 实际会用的供应商：选中项优先，未选过回落第一个可用（镜像 selectLlmProvider 的兜底）。 */
const activeLocalProvider = computed(
  () => localProviders.value.find((provider) => provider.id === settings.selectedModelProviderId) ?? localProviders.value[0] ?? null,
);

/** 当前生效档：会话覆盖 > 供应商配置 > auto（与 stream.ts 的实际调用同一来源）。 */
const activeEffort = computed<ReasoningEffort>(() => resolveLocalEffort(localReasoningOverride.value, activeLocalProvider.value));

function setLocalEffort(effort: ReasoningEffort): void {
  localReasoningOverride.value = effort;
}

/** 把当前生效档写回供应商配置（成为所有新会话的默认），并清掉会话覆盖。 */
function setDefaultEffort(): void {
  const provider = activeLocalProvider.value;
  if (!provider) return;
  settings.upsertModelProvider({ ...provider, reasoningEffort: activeEffort.value });
  localReasoningOverride.value = null;
}

/** 「…」菜单的 Esc / 点外部收回与键盘漫游都交给 DropdownMenu。 */

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  void agent.refreshAgentDetection();
  const rail = railEl.value;
  if (!rail) return;
  railWidth.value = rail.getBoundingClientRect().width;
  if (typeof ResizeObserver === "undefined") return;
  resizeObserver = new ResizeObserver((entries) => {
    railWidth.value = entries[0]?.contentRect.width ?? rail.getBoundingClientRect().width;
  });
  resizeObserver.observe(rail);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});
</script>

<template>
  <div class="flex w-full flex-col gap-1">
    <div class="flex h-5 items-center gap-2 px-0.5">
      <span class="shrink-0 text-[10.5px] font-semibold tracking-[0.1em] text-dim">ACP 选择</span>
      <span class="h-px min-w-3 flex-1 bg-line/70" aria-hidden="true" />
      <Hint text="一键降到只读跑完再升，避免长期停在完全访问">
        <button
          type="button"
          data-testid="temp-readonly-chip"
          :class="[
            'flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 text-[10px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan',
            settings.tempReadOnly ? 'bg-cyan/15 text-cyan' : 'text-dim2 hover:bg-panel hover:text-foreground',
          ]"
          :aria-pressed="settings.tempReadOnly"
          @click="toggleTempReadOnly(!settings.tempReadOnly)"
        >
          <Icon name="shield" :size="10" />
          <span>临时只读</span>
        </button>
      </Hint>
    </div>

    <div class="flex w-full items-center gap-2">
      <div class="shrink-0">
        <!-- 展开时名字已经显示在胶囊上，再弹提示是多余的 —— 传 null 让 Hint 直接透传。 -->
        <Hint :text="expandedChoice === 'local' ? null : 'Local'">
          <button
            type="button"
            data-testid="local-provider-button"
            :data-expanded="expandedChoice === 'local'"
            :class="[
              'flex h-8 cursor-pointer items-center overflow-hidden rounded-full border text-[11.5px] transition-[border-color,background-color,color,box-shadow] duration-200 ease-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan',
              selected === null
                ? 'border-cyan/70 bg-cyan/15 text-foreground shadow-[0_0_0_1px_rgba(77,159,255,0.12),0_0_18px_rgba(77,159,255,0.08)]'
                : 'border-line-2 bg-panel text-dim hover:border-cyan/50 hover:text-foreground',
            ]"
            :aria-pressed="selected === null"
            aria-label="Local"
            @click="selectLocal"
          >
            <span class="grid size-[30px] shrink-0 place-items-center">
              <Icon name="terminal" :size="14" class="text-dim" />
            </span>
            <!-- 收起即 0 宽：轨道 0fr 时整块被按钮的 overflow-hidden 裁掉，胶囊正好回到 32px 圆点。 -->
            <span
              class="grid min-w-0 transition-[grid-template-columns,padding,opacity] duration-200 ease-out"
              :class="expandedChoice === 'local' ? 'grid-cols-[1fr] pr-2.5 opacity-100' : 'grid-cols-[0fr] pr-0 opacity-0'"
            >
              <span class="min-w-0 max-w-[110px] truncate text-left">Local</span>
            </span>
          </button>
        </Hint>
      </div>

      <span class="mx-0.5 h-4 w-px shrink-0 bg-line-2" aria-hidden="true" />

      <div ref="railEl" data-testid="acp-provider-rail" class="flex min-w-0 flex-1 items-center gap-1.5">
        <Hint
          v-for="provider in visibleAcpOptions"
          :key="provider.id"
          :text="expandedChoice === provider.id ? null : providerHint(provider)"
        >
          <button
            type="button"
            data-testid="acp-provider-button"
            :data-provider-id="provider.id"
            :data-expanded="expandedChoice === provider.id"
            :class="[
              'relative flex h-8 cursor-pointer items-center overflow-hidden rounded-full border text-[11.5px] transition-[border-color,background-color,color,box-shadow] duration-200 ease-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan',
              selected === provider.id
                ? 'border-cyan/70 bg-cyan/15 text-foreground shadow-[0_0_0_1px_rgba(77,159,255,0.12),0_0_18px_rgba(77,159,255,0.08)]'
                : provider.enabled
                  ? 'border-line-2 bg-panel text-dim hover:border-cyan/50 hover:text-foreground'
                  : 'border-dashed border-line-2 bg-panel text-dim hover:border-cyan/40 hover:text-foreground',
            ]"
            :aria-pressed="selected === provider.id"
            :aria-label="provider.name"
            @click="selectAcp(provider.id)"
          >
            <span class="grid size-[30px] shrink-0 place-items-center">
              <AgentProviderIcon :provider="provider" :size="15" :class="provider.enabled ? 'opacity-100' : 'opacity-70'" />
            </span>
            <!-- 宽度由名字撑开；max-w-[110px] 封顶是槽位预算 162px 能兜住的前提（见上方常量注释）。 -->
            <span
              class="grid min-w-0 transition-[grid-template-columns,padding,opacity] duration-200 ease-out"
              :class="expandedChoice === provider.id ? 'grid-cols-[1fr] pr-2.5 opacity-100' : 'grid-cols-[0fr] pr-0 opacity-0'"
            >
              <span class="min-w-0 max-w-[110px] truncate text-left">{{ provider.name }}</span>
            </span>
            <span
              v-if="agent.providerInstalled(provider) !== null"
              class="absolute bottom-0.5 right-0.5 size-1.5 rounded-full ring-2 ring-panel"
              :class="agent.providerInstalled(provider) === true ? 'bg-cyan' : 'bg-orange'"
              aria-hidden="true"
            />
            <span
              v-if="agent.acpBusy && selected === provider.id"
              class="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-cyan"
            />
          </button>
        </Hint>
      </div>

      <!-- 固定外框配合容量预算，避免「…」出现后挤压轨道并触发来回抖动。 -->
      <div class="relative size-8 shrink-0">
        <DropdownMenu v-model:open="overflowOpen">
          <DropdownMenuTrigger as-child>
            <button
              v-if="overflowAcpOptions.length > 0"
              type="button"
              data-testid="acp-overflow-toggle"
              class="gw-bar-pop grid size-8 cursor-pointer place-items-center rounded-full border border-line-2 bg-panel text-dim transition-colors hover:border-cyan/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              aria-label="更多 ACP"
            >
              <Icon name="more" :size="13" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent data-testid="acp-overflow-menu" side="top" align="end" class="w-[220px] border-line-2">
            <DropdownMenuItem
              v-for="provider in overflowAcpOptions"
              :key="provider.id"
              data-testid="acp-overflow-item"
              :data-provider-id="provider.id"
              class="h-8 cursor-pointer gap-2 rounded-[7px] px-2 text-[11.5px] text-dim"
              @select="selectAcp(provider.id)"
            >
              <AgentProviderIcon :provider="provider" :size="14" />
              <span class="min-w-0 flex-1 truncate">{{ provider.name }}</span>
              <span
                v-if="agent.providerInstalled(provider) !== null"
                class="shrink-0 text-[10px]"
                :class="agent.providerInstalled(provider) === true ? 'text-cyan' : 'text-orange/80'"
              >
                {{ agent.providerInstallLabel(provider) }}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    <!-- Local 路由展开区：模型选择（即全局默认供应商）+ 会话级思考强度覆盖 -->
    <div v-if="expandedChoice === 'local'" data-testid="local-selector" class="gw-bar-rise flex flex-wrap items-center gap-1.5 pl-1">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            data-testid="local-model-button"
            class="flex h-6 cursor-pointer items-center gap-1.5 rounded-full border border-line-2 bg-panel px-2 text-[11px] text-dim transition-colors hover:border-cyan/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            aria-label="选择模型供应商"
          >
            <Icon name="terminal" :size="11" />
            <span class="max-w-[180px] truncate font-mono">{{ activeLocalProvider?.model || "选择模型" }}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" class="w-[240px] border-line-2">
          <DropdownMenuItem
            v-for="provider in localProviders"
            :key="provider.id"
            data-testid="local-model-item"
            :data-provider-id="provider.id"
            class="h-8 cursor-pointer gap-2 rounded-[7px] px-2 text-[11.5px]"
            :class="provider.id === settings.selectedModelProviderId ? 'text-foreground' : 'text-dim'"
            @select="settings.selectModelProvider(provider.id)"
          >
            <span class="min-w-0 flex-1 truncate">{{ provider.name }}</span>
            <span class="max-w-[45%] truncate font-mono text-[10.5px] text-dim2">{{ provider.model }}</span>
          </DropdownMenuItem>
          <p v-if="localProviders.length === 0" class="px-2 py-1.5 text-[11px] text-dim2">未配置可用模型，去设置页添加</p>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        v-for="effort in REASONING_EFFORTS"
        :key="effort.value"
        type="button"
        data-testid="local-effort-chip"
        :data-effort="effort.value"
        :class="[
          'flex h-6 cursor-pointer items-center rounded-full px-2 text-[10.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan',
          activeEffort === effort.value ? 'bg-cyan/15 text-cyan' : 'text-dim2 hover:bg-panel hover:text-foreground',
        ]"
        :aria-pressed="activeEffort === effort.value"
        @click="setLocalEffort(effort.value)"
      >
        {{ t(effort.label) }}
      </button>
      <Hint text="把当前思考强度写回该供应商，成为所有新会话的默认">
        <button
          type="button"
          data-testid="local-effort-default"
          class="flex h-6 cursor-pointer items-center rounded-full border border-line-2 bg-panel px-2 text-[10.5px] text-dim transition-colors hover:border-cyan/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="setDefaultEffort"
        >
          设为默认
        </button>
      </Hint>
    </div>

    <p v-if="settings.tempReadOnly" class="gw-bar-rise flex items-center gap-1.5 pl-1 text-[11px] text-dim">
      已临时降级为只读 · 基线 {{ TIER_LABELS[settings.permissionTier] }}
      <button
        type="button"
        data-testid="temp-readonly-restore"
        class="cursor-pointer rounded-[5px] px-1 text-cyan underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        @click="toggleTempReadOnly(false)"
      >
        恢复
      </button>
    </p>
    <p
      v-if="connectError || (selected !== null && agent.acpStatus === 'error')"
      role="alert"
      class="gw-bar-rise truncate pl-1 text-[11px] text-orange"
    >
      <Icon name="close-one" :size="11" class="inline" />
      {{ connectError ?? "连接失败 —— 点击后端图标重试" }}
    </p>
  </div>
</template>

<style scoped>
/* 选择栏的入场动效一律用关键帧（只做进场），不用 <Transition> 的 leave：
 * 退场直接卸载元素，不留过渡尾巴 —— 否则 DOM 会多挂一帧，既拖住下方布局，
 * 也让「点完立刻查 DOM」的测试（如 local-selector 收起）失准。 */
@keyframes gw-bar-rise {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}
.gw-bar-rise {
  animation: gw-bar-rise 180ms ease-out;
}

/* 「…」溢出按钮：出现时缩一下再落位，避免整颗按钮凭空闪现。 */
@keyframes gw-bar-pop {
  from {
    opacity: 0;
    transform: scale(0.75);
  }
}
.gw-bar-pop {
  animation: gw-bar-pop 160ms ease-out;
}
</style>
