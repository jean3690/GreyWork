<script setup lang="ts">
/**
 * 设置内容面板：按 `section` prop 分派子面板（分区导航由 SettingsDialog 持有）。
 * 每个分区一个 Pane 组件（AgentSettingsPane / AppearanceSettingsPane / …），
 * 字段直接写 settings store，变更即持久化。
 */
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import StorageSettings from "@/features/settings/StorageSettings.vue";
import AgentSettingsPane from "@/features/settings/AgentSettingsPane.vue";
import AppearanceSettingsPane from "@/features/settings/AppearanceSettingsPane.vue";
import AssistantSettingsPane from "@/features/settings/AssistantSettingsPane.vue";
import McpPane from "@/features/settings/McpPane.vue";
import ModeSettingsPane from "@/features/settings/ModeSettingsPane.vue";
import SettingsSkills from "@/features/settings/SettingsSkills.vue";
import SystemSettingsPane from "@/features/settings/SystemSettingsPane.vue";
import TeamSettingsPane from "@/features/settings/TeamSettingsPane.vue";
import { useAgentStore } from "@/stores/agent";

const props = defineProps<{ section: string }>();

const { t } = useI18n();
const agent = useAgentStore();

const SECTION_KEYS = ["agent", "assistant", "appearance", "mode", "system", "mcp", "skills", "storage", "team"] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

/** 分区的标题与说明都走 i18n（settings.sections.*），侧栏导航的短标签在 SettingsDialog。 */
const meta = computed(() => {
  const key: SectionKey = SECTION_KEYS.find((candidate) => candidate === props.section) ?? "agent";
  return { title: t(`settings.sections.${key}.title`), desc: t(`settings.sections.${key}.desc`) };
});

onMounted(() => {
  void agent.refreshAgentDetection();
});
</script>

<template>
  <section class="mx-auto min-h-0 h-full w-full max-w-[720px] overflow-y-auto px-4 py-6 sm:px-6">
    <header class="mb-6">
      <h1 class="font-display text-[20px] font-bold tracking-tight text-foreground">{{ meta.title }}</h1>
      <p class="mt-1 text-[12px] text-dim2">{{ meta.desc }}</p>
    </header>

    <AgentSettingsPane v-if="section === 'agent'" />
    <AssistantSettingsPane v-else-if="section === 'assistant'" />
    <AppearanceSettingsPane v-else-if="section === 'appearance'" />
    <ModeSettingsPane v-else-if="section === 'mode'" />
    <SystemSettingsPane v-else-if="section === 'system'" />
    <McpPane v-else-if="section === 'mcp'" />
    <SettingsSkills v-else-if="section === 'skills'" />
    <StorageSettings v-else-if="section === 'storage'" />
    <TeamSettingsPane v-else-if="section === 'team'" />
  </section>
</template>
