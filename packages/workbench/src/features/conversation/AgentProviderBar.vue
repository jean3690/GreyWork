<script setup lang="ts">
/**
 * ACP 后端图标轨道：初始只显示图标，点击项独占文字展开，其余保持收起。
 * 宽度不足时当前展开项始终留在主轨道，其他项收进「…」菜单。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { type AgentProviderConfig } from "@greywork/shell";
import { useAgentStore } from "@/stores/agent";
import { useSettingsStore } from "@/stores/settings";
import AgentProviderIcon from "@/features/conversation/AgentProviderIcon.vue";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const agent = useAgentStore();
const settings = useSettingsStore();

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
 * 主轨道容量使用保守固定槽位计算：收起项 32px + 6px gap；展开项固定 156px + gap。
 * 始终预留「…」和一个收起项变成展开项的增量空间，点击前后可见项数量不跳变。
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
            :class="[
              'flex h-8 cursor-pointer items-center overflow-hidden rounded-full border text-[11.5px] transition-[width,border-color,background-color,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan',
              expandedChoice === 'local' ? 'w-[96px] justify-start gap-1.5 px-2.5' : 'w-8 justify-center p-0',
              selected === null
                ? 'border-cyan/70 bg-cyan/15 text-foreground shadow-[0_0_0_1px_rgba(77,159,255,0.12),0_0_18px_rgba(77,159,255,0.08)]'
                : 'border-line-2 bg-panel text-dim hover:border-cyan/50 hover:text-foreground',
            ]"
            :aria-pressed="selected === null"
            aria-label="Local"
            @click="selectLocal"
          >
            <Icon name="terminal" :size="14" class="shrink-0 text-dim" />
            <span v-if="expandedChoice === 'local'" class="truncate whitespace-nowrap">Local</span>
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
            :class="[
              'relative flex h-8 cursor-pointer items-center overflow-hidden rounded-full border text-[11.5px] transition-[width,border-color,background-color,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan',
              expandedChoice === provider.id ? 'w-[156px] justify-start gap-1.5 px-2.5' : 'w-8 justify-center p-0',
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
            <AgentProviderIcon :provider="provider" :size="15" :class="provider.enabled ? 'opacity-100' : 'opacity-70'" />
            <span v-if="expandedChoice === provider.id" class="min-w-0 flex-1 truncate whitespace-nowrap text-left">{{
              provider.name
            }}</span>
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
              class="grid size-8 cursor-pointer place-items-center rounded-full border border-line-2 bg-panel text-dim transition-colors hover:border-cyan/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
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

    <p v-if="settings.tempReadOnly" class="flex items-center gap-1.5 pl-1 text-[11px] text-dim">
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
    <p v-if="connectError || (selected !== null && agent.acpStatus === 'error')" role="alert" class="truncate pl-1 text-[11px] text-orange">
      <Icon name="close-one" :size="11" class="inline" />
      {{ connectError ?? "连接失败 —— 点击后端图标重试" }}
    </p>
  </div>
</template>
