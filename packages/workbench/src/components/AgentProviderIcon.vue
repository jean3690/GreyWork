<script setup lang="ts">
import { computed } from "vue";
// 子路径只加载框架无关的 URL 生成器；包根还会加载 React 图标树，Vue 端不应承担它。
import { getLobeIconCDN } from "@lobehub/icons/es/features/getLobeIconCDN";
import type { AgentProviderConfig } from "@greywork/shell";
import { agentProviderIcon, agentProviderLobeIcon } from "@greywork/shell";
import Icon from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    provider: Pick<AgentProviderConfig, "id" | "icon">;
    size?: number;
  }>(),
  { size: 16 },
);

const lobeIcon = computed(() => agentProviderLobeIcon(props.provider));
const lobeUrl = computed(() =>
  lobeIcon.value
    ? getLobeIconCDN(lobeIcon.value.slug, {
        cdn: "unpkg",
        format: "svg",
        type: lobeIcon.value.type,
      })
    : null,
);
</script>

<template>
  <img
    v-if="lobeUrl"
    :src="lobeUrl"
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
