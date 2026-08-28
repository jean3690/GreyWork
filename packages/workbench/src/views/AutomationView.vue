<script setup lang="ts">
import { Switch } from "../components/ui";
import { ref } from "vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

interface AutomationTask {
  id: string;
  name: string;
  trigger: string;
  target: string;
  enabled: boolean;
  last: string;
}

let seq = 0;

const automations = ref<AutomationTask[]>([
  { id: "at-1", name: "整理项目状态", trigger: "每天 09:00", target: "GreyWork 主仓", enabled: true, last: "今天 09:00" },
  { id: "at-2", name: "自动生成周报", trigger: "每周五 18:00", target: "城市数据洞察", enabled: false, last: "上周五 18:00" },
  { id: "at-3", name: "依赖安全巡检", trigger: "每天 03:00", target: "全部项目", enabled: true, last: "今天 03:00" },
]);

function addAutomation(): void {
  seq += 1;
  automations.value.unshift({
    id: `at-new-${seq}`,
    name: t("automation.newTask"),
    trigger: t("automation.manualTrigger"),
    target: t("automation.unboundProject"),
    enabled: false,
    last: t("automation.neverRun"),
  });
}
</script>

<template>
  <section class="view">
    <div class="view__head">
      <div>
        <p class="view__eyebrow">AUTOMATION</p>
        <h1 class="view__title">{{ t("automation.title") }}</h1>
        <p class="view__sub">{{ t("automation.sub") }}</p>
      </div>
      <div class="view__actions">
        <button class="btn btn--primary" @click="addAutomation">{{ t("automation.create") }}</button>
      </div>
    </div>
    <div class="auto-list">
      <div v-for="a in automations" :key="a.id" class="auto-card" :data-on="a.enabled">
        <Switch v-model="a.enabled" />
        <div class="auto-card__body">
          <strong>{{ a.name }}</strong>
          <span>{{ a.trigger }} · {{ a.target }}</span>
        </div>
        <em>{{ t("automation.lastRun", { last: a.last }) }}</em>
        <span class="auto-card__state">{{ a.enabled ? t("automation.enabled") : t("automation.paused") }}</span>
      </div>
    </div>
    <p class="footnote">{{ t("automation.footnote") }}</p>
  </section>
</template>
