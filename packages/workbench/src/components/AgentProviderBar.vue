<script setup lang="ts">
/**
 * 运行后端选择条（对齐 GreyWork Guid 页 AssistantSelectionArea 形态）：
 * 胶囊横条列出全部 ACP agent（opencode / codex / claude-code…）+ 本地 LLM。
 * 选中 ACP agent 后发送路由走 agent store 的 dispatchToAcp（真实 CLI agent 回合）；
 * 选中 Local 走 chat store 的 LLM/mock 管线。权限档位（cautious/daily/auto）随
 * settings 全局档位，宿主执行（acp_host PermissionTier）。
 *
 * 选择即启用：点未启用的后端胶囊会先启用再建会话（一步到位选到其他 ACP），
 * 不必先去设置页勾选。未安装的后端显式标「未安装 / 首次启动下载」并给出安装提示。
 *
 * 选中 ACP 后端时的会话配置选择器（模型 / 思考强度 / 会话模式）由
 * AcpSessionConfig 渲染在输入卡底栏（发送按钮旁）；本条只负责后端选择与
 * 连接失败的就地提示（点击后端胶囊重试，不再静默吞错）。
 */
import { computed, onMounted, ref } from "vue";
import { useAgentStore } from "../stores/agent";
import { useSettingsStore } from "../stores/settings";
import Icon from "./Icon.vue";
import type { AgentProviderConfig } from "@greywork/shell";

const agent = useAgentStore();
const settings = useSettingsStore();

/** 全部 ACP 后端（不止 enabled）——未启用的也能从条上一步选到，不必先去设置页勾选。 */
const acpOptions = computed<AgentProviderConfig[]>(() => agent.agentProviders);

/** 当前选中：null = 本地 LLM 管线。 */
const selected = computed(() => (agent.routeToAcp ? agent.selectedProviderId : null));

/** 最近一次连接失败文案（null = 无）；仅在展示处消费，不长期驻留。 */
const connectError = ref<string | null>(null);

/** 基线档位中文名（临时降级提示里点明「降的是哪一档」）。 */
const TIER_LABELS: Record<string, string> = { "read-only": "只读", workspace: "工作区", full: "完全访问" };

function selectLocal(): void {
  connectError.value = null;
  void agent.switchToLocalLlm();
}

async function selectAcp(id: string): Promise<void> {
  connectError.value = null;
  // 未启用的后端：先启用再走激活（选择即启用，一步到位选到其他 ACP）。
  const provider = agent.agentProviders.find((candidate) => candidate.id === id);
  if (provider && !provider.enabled) await agent.setAgentProviderEnabled(id, true);
  // 同后端已连接：点击无操作（幂等）。未连接 / 连接失败时点击即重试建会话，
  // 让「点了没反应 → 模型/思考强度选择器出现」的路径有明确入口。
  if (id === agent.selectedProviderId && agent.routeToAcp && agent.acpConnected) return;
  connectError.value = await agent.activateAcpProvider(id);
}

/** 一键临时降级/回升；失败（如宿主不认这个 handle）就地落文案。 */
async function toggleTempReadOnly(on: boolean): Promise<void> {
  connectError.value = await agent.setTempReadOnly(on);
}

/**
 * 选择条挂载即探测本机 CLI 安装状态（桌面态；浏览器态后端不接管 → 静默无结果）。
 * 仅在此触发，确保 Guid / Conversation 两条渲染路径都能就地显示「已安装 / 首次启动下载 / 未安装」，
 * 不必依赖用户先去过设置页（设置页的探测是 duplicate 调用，幂等且被 store 合并）。
 */
onMounted(() => {
  void agent.refreshAgentDetection();
});
</script>

<template>
  <div class="flex w-full flex-col gap-1">
    <div class="flex w-full items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
      <!-- 本地 LLM -->
      <button
        type="button"
        :class="[
          'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan',
          selected === null
            ? 'border-cyan/60 bg-cyan/10 text-foreground'
            : 'border-line bg-panel text-dim hover:border-line-2 hover:text-foreground',
        ]"
        :aria-pressed="selected === null"
        @click="selectLocal"
      >
        <Icon name="lightning" :size="12" class="text-dim" />
        <span class="whitespace-nowrap"
          >Local · {{ settings.runMode === "cloud" ? "Cloud" : settings.runMode === "worktree" ? "Worktree" : "Desktop" }}</span
        >
      </button>

      <!-- ACP agent 胶囊（全部后端，未启用的也能一步选到） -->
      <button
        v-for="provider in acpOptions"
        :key="provider.id"
        type="button"
        :class="[
          'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan',
          selected === provider.id
            ? 'border-cyan/60 bg-cyan/10 text-foreground'
            : provider.enabled
              ? 'border-line bg-panel text-dim hover:border-line-2 hover:text-foreground'
              : 'border-dashed border-line bg-panel text-dim2 hover:border-line-2 hover:text-foreground',
        ]"
        :aria-pressed="selected === provider.id"
        :title="provider.enabled ? provider.command : (provider.installHint ?? provider.command)"
        @click="selectAcp(provider.id)"
      >
        <Icon name="robot" :size="12" :class="provider.enabled ? 'text-dim' : 'text-dim2'" />
        <span class="whitespace-nowrap">{{ provider.name }}</span>
        <!-- 安装状态：探测有结论才显（未知则不喧宾夺主）；
             已装中性、未装橙色引导；npx 型直说「首次启动下载」 -->
        <span
          v-if="agent.providerInstalled(provider) !== null"
          class="shrink-0 text-[10px]"
          :class="agent.providerInstalled(provider) === true ? 'text-dim2' : 'text-orange/80'"
          :title="provider.installHint ?? provider.command"
        >
          {{ agent.providerInstallLabel(provider) }}
        </span>
        <span v-if="agent.acpBusy && selected === provider.id" class="size-1.5 animate-pulse rounded-full bg-cyan" />
      </button>

      <!-- 临时降级：Full 会话内一键降只读，跑完再升，避免长期停在完全访问 -->
      <button
        type="button"
        data-testid="temp-readonly-chip"
        :class="[
          'ml-auto flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan',
          settings.tempReadOnly
            ? 'border-cyan/60 bg-cyan/10 text-foreground'
            : 'border-line bg-panel text-dim hover:border-line-2 hover:text-foreground',
        ]"
        :aria-pressed="settings.tempReadOnly"
        title="一键降到只读跑完再升，避免长期停在完全访问"
        @click="toggleTempReadOnly(!settings.tempReadOnly)"
      >
        <Icon name="shield" :size="12" />
        <span class="whitespace-nowrap">临时只读</span>
      </button>
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
      {{ connectError ?? "连接失败 —— 点击后端胶囊重试" }}
    </p>
  </div>
</template>
