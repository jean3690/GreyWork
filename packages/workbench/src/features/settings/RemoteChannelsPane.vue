<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAgentStore } from "@/stores/agent";
import { useRemoteAssistantStore, type RemoteChannel } from "@/stores/remote-assistant";
import { useSettingsStore } from "@/stores/settings";
import { useSkillsStore } from "@/stores/skills";
import Icon from "@/features/shared/Icon.vue";
import RemoteChannelDialog from "@/features/settings/RemoteChannelDialog.vue";
import RemoteReplyDialog from "@/features/settings/RemoteReplyDialog.vue";
import RemoteMcpDialog from "@/features/settings/RemoteMcpDialog.vue";
import RemoteSkillsDialog from "@/features/settings/RemoteSkillsDialog.vue";

/**
 * 设置 · 远程助手：一张「图标 + 描述」的集成清单，点任意一行开对应配置弹窗。
 *
 * 为什么改成列表 + 弹窗：原先每个通道一张大卡片（凭证、扫码、三个开关全摊开），
 * 四条通道叠起来要滚三屏，真正要改的那一项反而找不到。清单只留「是什么 / 现在什么
 * 状态」，配置进弹窗按需展开。
 *
 * 这里是通道配置的唯一入口（远程助手页只给一个「去设置配置」的跳转）：
 * - 微信：腾讯官方 ClawBot / iLink，扫码登录 + 长轮询；
 * - 钉钉：开放平台企业内部机器人，Stream 长连接（Client ID / Client Secret）；
 * - 飞书：自建应用 + 长连接（App ID / App Secret），也可扫码创建；
 * - Telegram：官方 Bot API 长轮询，一个 bot token 即可。
 *
 * 凭证一律不进设置快照：微信的 bot token、钉钉的 AppSecret 与 sessionWebhook、
 * 飞书的 AppSecret 与 tenant token、Telegram 的 bot token 都只落宿主数据目录（0600）。
 */
const { t } = useI18n();
const store = useRemoteAssistantStore();
const settings = useSettingsStore();
const agent = useAgentStore();
const skills = useSkillsStore();

/** 弹窗标识：通道用通道 id，本机集成用固定名。null = 全部关闭。 */
type DialogId = RemoteChannel | "reply" | "mcp" | "skills";
const openDialog = ref<DialogId | null>(null);

/** 通道行清单（顺序即界面顺序）；RemoteChannel 与设置里的 ChannelId 取值一致。 */
const CHANNELS: readonly RemoteChannel[] = ["wechat", "dingtalk", "feishu", "telegram", "qq", "discord", "wecom"];

/** 通道行的状态胶囊：未配置 / 未连接 / 连接中 / 已连接 / 异常。 */
function channelBadge(channel: RemoteChannel): { text: string; className: string } {
  const status = store.statusOf(channel);
  if (!store.available) return { text: t("remoteAssist.channels.desktopOnly"), className: "border-line text-dim2" };
  if (!status.ready) return { text: t("remoteAssist.rows.notConfigured"), className: "border-line text-dim2" };
  if (status.state === "connected") return { text: t("remoteAssist.status.connected"), className: "border-mint/40 text-mint" };
  if (status.state === "connecting") return { text: t("remoteAssist.status.connecting"), className: "border-cyan/40 text-cyan" };
  if (status.state === "error") return { text: t("remoteAssist.status.error"), className: "border-destructive/40 text-destructive" };
  return { text: t("remoteAssist.status.stopped"), className: "border-line text-dim2" };
}

/** 回复管线行的状态：本机模型 or ACP 后端名。 */
const replyBadge = computed(() => {
  if (settings.remoteAssist.replyMode !== "acp") return t("remoteAssist.settings.replyLlm");
  const id = settings.remoteAssist.replyProviderId;
  if (!id) return t("remoteAssist.settings.replyProviderFollow");
  return agent.agentProviders.find((provider) => provider.id === id)?.name ?? id;
});

const mcpBadge = computed(() =>
  t("remoteAssist.rows.mcpBadge", {
    enabled: settings.mcpServers.filter((server) => server.enabled).length,
    total: settings.mcpServers.length,
  }),
);

const skillsBadge = computed(() => t("remoteAssist.rows.skillsBadge", { count: skills.installed.length }));

const integrations = computed<{ id: DialogId; icon: string; name: string; desc: string; badge: string; testId: string }[]>(() => [
  {
    id: "reply",
    icon: "robot",
    name: t("remoteAssist.rows.replyName"),
    desc: t("remoteAssist.rows.replyDesc"),
    badge: replyBadge.value,
    testId: "integration-reply",
  },
  {
    id: "mcp",
    icon: "terminal",
    name: t("remoteAssist.rows.mcpName"),
    desc: t("remoteAssist.rows.mcpDesc"),
    badge: mcpBadge.value,
    testId: "integration-mcp",
  },
  {
    id: "skills",
    icon: "lightning",
    name: t("remoteAssist.rows.skillsName"),
    desc: t("remoteAssist.rows.skillsDesc"),
    badge: skillsBadge.value,
    testId: "integration-skills",
  },
]);

onMounted(() => {
  // 打开设置面板就该看到真实的已装技能数（磁盘扫描，不读缓存）。
  void skills.refreshInstalled();
});
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="remote-channels-pane">
    <section>
      <h3 class="mb-2 text-[11px] font-medium uppercase tracking-wide text-dim2">{{ t("remoteAssist.rows.channelsSection") }}</h3>
      <div class="flex flex-col gap-1.5">
        <button
          v-for="channel in CHANNELS"
          :key="channel"
          type="button"
          class="flex cursor-pointer items-center gap-3 rounded-[12px] border border-line bg-panel px-3 py-2.5 text-left transition-colors hover:border-line-2 hover:bg-panel-2"
          :data-testid="`row-${channel}`"
          @click="openDialog = channel"
        >
          <span class="grid size-8 shrink-0 place-items-center rounded-[9px] border border-line bg-panel-2 text-dim">
            <Icon name="message" :size="15" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-[12.5px] font-medium text-foreground">{{ t(`remoteAssist.channels.${channel}`) }}</span>
            <span class="mt-0.5 block truncate text-[11px] text-dim2">{{ t(`remoteAssist.rows.${channel}Desc`) }}</span>
          </span>
          <span class="shrink-0 rounded-full border px-2 py-0.5 text-[10px]" :class="channelBadge(channel).className">
            {{ channelBadge(channel).text }}
          </span>
          <Icon name="right" :size="12" class="shrink-0 text-dim2" />
        </button>
      </div>
    </section>

    <section>
      <h3 class="mb-2 text-[11px] font-medium uppercase tracking-wide text-dim2">{{ t("remoteAssist.rows.integrationsSection") }}</h3>
      <div class="flex flex-col gap-1.5">
        <button
          v-for="entry in integrations"
          :key="entry.id"
          type="button"
          class="flex cursor-pointer items-center gap-3 rounded-[12px] border border-line bg-panel px-3 py-2.5 text-left transition-colors hover:border-line-2 hover:bg-panel-2"
          :data-testid="`row-${entry.testId}`"
          @click="openDialog = entry.id"
        >
          <span class="grid size-8 shrink-0 place-items-center rounded-[9px] border border-line bg-panel-2 text-dim">
            <Icon :name="entry.icon" :size="15" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-[12.5px] font-medium text-foreground">{{ entry.name }}</span>
            <span class="mt-0.5 block truncate text-[11px] text-dim2">{{ entry.desc }}</span>
          </span>
          <span class="max-w-[40%] shrink-0 truncate rounded-full border border-line px-2 py-0.5 text-[10px] text-dim2">
            {{ entry.badge }}
          </span>
          <Icon name="right" :size="12" class="shrink-0 text-dim2" />
        </button>
      </div>
    </section>

    <p class="text-[10.5px] leading-relaxed text-dim2">{{ t("remoteAssist.settings.security") }}</p>

    <RemoteChannelDialog
      v-if="openDialog && CHANNELS.includes(openDialog as RemoteChannel)"
      :open="true"
      :channel="openDialog as RemoteChannel"
      @close="openDialog = null"
    />
    <RemoteReplyDialog v-else-if="openDialog === 'reply'" :open="true" @close="openDialog = null" />
    <RemoteMcpDialog v-else-if="openDialog === 'mcp'" :open="true" @close="openDialog = null" />
    <RemoteSkillsDialog v-else-if="openDialog === 'skills'" :open="true" @close="openDialog = null" />
  </div>
</template>
