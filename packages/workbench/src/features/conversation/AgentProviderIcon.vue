<script setup lang="ts">
import { computed } from "vue";
import type { AgentProviderConfig } from "@greywork/shell";
import { agentProviderIcon, agentProviderLobeIcon } from "@greywork/shell";
import Icon from "@/features/shared/Icon.vue";

/*
 * 品牌图标随包发出，不请求 CDN。
 *
 * 原因：打包版 CSP 是 `img-src 'self' data: blob:`（tauri.conf.json），unpkg 的图会被
 * 直接拦掉 —— 现象就是设置页/发送条上的 ACP 图标一片空白（浏览器 dev 无 CSP 才看得见，
 * 所以只在打包版、尤其 Windows 上暴露）。离线与国内网络下 CDN 也不可用。
 *
 * 文件取自 @lobehub/icons-static-svg@1.95.0（MIT），命名沿用上游约定：
 * mono 为 `<slug>.svg`，color 为 `<slug>-color.svg`。slug 由 shell 的
 * AGENT_PROVIDER_LOBE_ICON 给出，本文件只负责「文件名 → 本地资源」的映射。
 */
import opencodeIcon from "@/assets/agent-icons/opencode.svg?url";
import codexColorIcon from "@/assets/agent-icons/codex-color.svg?url";
import claudeCodeColorIcon from "@/assets/agent-icons/claudecode-color.svg?url";
import geminiColorIcon from "@/assets/agent-icons/geminicli-color.svg?url";
import qwenColorIcon from "@/assets/agent-icons/qwen-color.svg?url";
import moonshotIcon from "@/assets/agent-icons/moonshot.svg?url";
import chatglmColorIcon from "@/assets/agent-icons/chatglm-color.svg?url";
import cursorIcon from "@/assets/agent-icons/cursor.svg?url";
import githubCopilotIcon from "@/assets/agent-icons/githubcopilot.svg?url";
import gooseIcon from "@/assets/agent-icons/goose.svg?url";
import ampColorIcon from "@/assets/agent-icons/amp-color.svg?url";

/** 品牌图标本地资源表：key 是上游文件名，与 AGENT_PROVIDER_LOBE_ICON 的 slug+type 一一对应。 */
const BRAND_ICON_ASSETS: Readonly<Record<string, string>> = {
  "opencode.svg": opencodeIcon,
  "codex-color.svg": codexColorIcon,
  "claudecode-color.svg": claudeCodeColorIcon,
  "geminicli-color.svg": geminiColorIcon,
  "qwen-color.svg": qwenColorIcon,
  "moonshot.svg": moonshotIcon,
  "chatglm-color.svg": chatglmColorIcon,
  "cursor.svg": cursorIcon,
  "githubcopilot.svg": githubCopilotIcon,
  "goose.svg": gooseIcon,
  "amp-color.svg": ampColorIcon,
};

const props = withDefaults(
  defineProps<{
    provider: Pick<AgentProviderConfig, "id" | "icon">;
    size?: number;
  }>(),
  { size: 16 },
);

const lobeIcon = computed(() => agentProviderLobeIcon(props.provider));

/** 缺资源时回落通用图标，而不是留一个裂图。 */
const brandIconUrl = computed(() => {
  const icon = lobeIcon.value;
  if (!icon) return null;
  const file = icon.type === "color" ? `${icon.slug}-color.svg` : `${icon.slug}.svg`;
  return BRAND_ICON_ASSETS[file] ?? null;
});
</script>

<template>
  <img
    v-if="brandIconUrl"
    :src="brandIconUrl"
    :width="size"
    :height="size"
    :alt="`${lobeIcon?.slug} brand`"
    :class="['inline-block shrink-0 object-contain align-middle', lobeIcon?.type === 'mono' ? 'agent-provider-icon--mono' : undefined]"
    data-testid="agent-brand-icon"
  />
  <Icon v-else :name="agentProviderIcon(provider)" :size="size" data-testid="agent-generic-icon" />
</template>

<style scoped>
/* mono 品牌图标是「黑字透明底」，深色画布上要反相一档才看得清。
 * 别再套 :global() —— Vue 的 scoped 编译器把 `:global(:root[data-theme="dark"]) .foo`
 * 降级成了 `:root[data-theme="dark"] { filter: ... }`，等于给整页反相 88%：
 * 深色模式看上去是一片浅灰 + 蓝色主键变橙。直接写复合选择器，作用域属性会落在类上。 */
:root[data-theme="dark"] .agent-provider-icon--mono {
  filter: invert(0.88);
}
</style>
