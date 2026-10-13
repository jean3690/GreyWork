<script setup lang="ts">
/**
 * 起跑表单的「本轮能力」卡：勾选本轮带给每个成员的 MCP 服务器与技能。
 *
 * 纯展示 + 选择，不发任何请求：MCP 列表与技能清单由父组件（CoworkPanel）从
 * settings / cowork store 取。选中集用 `v-model`（defineModel）双向绑定 ——
 * 父组件在 startRun 时把它们翻译成 `CoworkRunOptions`。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "@/features/shared/Icon.vue";
import type { McpServerEntry } from "@/stores/settings";
import type { InstalledSkill } from "@/stores/skills";

const { t } = useI18n();

const props = defineProps<{
  mcpServers: readonly McpServerEntry[];
  skills: readonly InstalledSkill[];
  skillsLoading?: boolean;
  /** 技能勾选只在 worktree 隔离档位生效 —— 其它档位给一条说明。 */
  worktreeOnly?: boolean;
}>();

const selectedMcp = defineModel<string[]>("selectedMcp", { required: true });
const selectedSkills = defineModel<string[]>("selectedSkills", { required: true });

const mcpSet = computed(() => new Set(selectedMcp.value));
const skillSet = computed(() => new Set(selectedSkills.value));

function toggle(ids: string[], id: string, on: boolean): string[] {
  return on ? [...new Set([...ids, id])] : ids.filter((candidate) => candidate !== id);
}
</script>

<template>
  <section class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-3.5">
    <div class="mb-0.5 flex items-center gap-2">
      <Icon name="hammer" :size="13" class="text-dim" />
      <h3 class="text-[12px] font-semibold text-foreground">{{ t("cowork.tooling.title") }}</h3>
    </div>
    <p class="mb-3 text-[11px] text-dim2">{{ t("cowork.tooling.sub") }}</p>

    <!-- MCP 服务器：勾选即随每个成员会话声明给 agent -->
    <div>
      <div class="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-dim">
        <Icon name="terminal" :size="12" class="text-dim2" />
        <span>{{ t("cowork.tooling.mcp") }}</span>
        <span class="rounded-full bg-panel-2 px-1.5 text-[10px] text-dim2">{{ selectedMcp.length }}/{{ props.mcpServers.length }}</span>
      </div>
      <p v-if="props.mcpServers.length === 0" class="text-[11px] text-dim2">{{ t("cowork.tooling.mcpEmpty") }}</p>
      <div v-else class="flex flex-wrap gap-1.5">
        <button
          v-for="server in props.mcpServers"
          :key="server.id"
          type="button"
          class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors"
          :class="mcpSet.has(server.id) ? 'border-accent/60 bg-accent/10 text-foreground' : 'border-line text-dim2 hover:text-foreground'"
          :aria-pressed="mcpSet.has(server.id)"
          :data-testid="`tooling-mcp-${server.id}`"
          @click="selectedMcp = toggle(selectedMcp, server.id, !mcpSet.has(server.id))"
        >
          <span class="size-1.5 rounded-full" :class="mcpSet.has(server.id) ? 'bg-accent' : 'bg-line-2'" />
          {{ server.name }}
          <span class="text-[10px] text-dim2">{{ server.transport }}</span>
        </button>
      </div>
    </div>

    <!-- 技能 -->
    <div class="mt-3">
      <div class="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-dim">
        <Icon name="magic" :size="12" class="text-dim2" />
        <span>{{ t("cowork.tooling.skills") }}</span>
        <span class="rounded-full bg-panel-2 px-1.5 text-[10px] text-dim2">{{ selectedSkills.length }}/{{ props.skills.length }}</span>
      </div>
      <p v-if="props.skillsLoading" class="text-[11px] text-dim2">{{ t("cowork.tooling.skillsLoading") }}</p>
      <p v-else-if="props.skills.length === 0" class="text-[11px] text-dim2">{{ t("cowork.tooling.skillsEmpty") }}</p>
      <div v-else class="flex flex-wrap gap-1.5">
        <button
          v-for="skill in props.skills"
          :key="skill.id"
          type="button"
          class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors"
          :class="skillSet.has(skill.id) ? 'border-cyan/60 bg-cyan/10 text-foreground' : 'border-line text-dim2 hover:text-foreground'"
          :aria-pressed="skillSet.has(skill.id)"
          :data-testid="`tooling-skill-${skill.id}`"
          @click="selectedSkills = toggle(selectedSkills, skill.id, !skillSet.has(skill.id))"
        >
          <span class="size-1.5 rounded-full" :class="skillSet.has(skill.id) ? 'bg-cyan' : 'bg-line-2'" />
          {{ skill.name }}
        </button>
      </div>
      <p v-if="props.worktreeOnly && props.skills.length > 0" class="mt-2 text-[10.5px] text-amber">
        {{ t("cowork.tooling.skillsWorktreeOnly") }}
      </p>
    </div>
  </section>
</template>
