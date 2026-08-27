<script setup lang="ts">
import { Switch } from "../components/ui";
import { ref } from "vue";

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
    name: "新建自动化任务",
    trigger: "手动触发",
    target: "未绑定项目",
    enabled: false,
    last: "从未运行",
  });
}
</script>

<template>
  <section class="view">
    <div class="view__head">
      <div>
        <p class="view__eyebrow">AUTOMATION</p>
        <h1 class="view__title">自动化</h1>
        <p class="view__sub">按时间或规则定时执行的任务，自动整理项目状态、生成日报周报。</p>
      </div>
      <div class="view__actions"><button class="btn btn--primary" @click="addAutomation">新建自动化</button></div>
    </div>
    <div class="auto-list">
      <div v-for="a in automations" :key="a.id" class="auto-card" :data-on="a.enabled">
        <Switch v-model="a.enabled" />
        <div class="auto-card__body">
          <strong>{{ a.name }}</strong>
          <span>{{ a.trigger }} · {{ a.target }}</span>
        </div>
        <em>上次运行：{{ a.last }}</em>
        <span class="auto-card__state">{{ a.enabled ? "已启用" : "已暂停" }}</span>
      </div>
    </div>
    <p class="footnote">自动化任务在本地沙箱中运行，输出会写入对应项目的历史线程。</p>
  </section>
</template>
