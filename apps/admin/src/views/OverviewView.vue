<script setup lang="ts">
import { Cpu, Monitor, Tickets, User, Warning } from "@element-plus/icons-vue";
import { computed, onMounted, ref } from "vue";
import { adminApi } from "../api";
import { ApiError } from "../api/http";
import StatCard from "../components/StatCard.vue";
import TrendBars from "../components/TrendBars.vue";
import type { Overview } from "../types";
import { actionMeta, formatDateTime, formatNumber, formatTokens } from "../utils/format";

const data = ref<Overview | null>(null);
const loading = ref(false);
const error = ref("");

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    data.value = await adminApi.overview();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "概览加载失败";
  } finally {
    loading.value = false;
  }
}

const channelRows = computed(() => {
  const channels = data.value?.channels;
  if (!channels) {
    return [];
  }
  const total = Math.max(1, channels.total);
  return [
    { label: "正常", value: channels.active, percent: Math.round((channels.active / total) * 100), tone: "mint" },
    { label: "降级", value: channels.degraded, percent: Math.round((channels.degraded / total) * 100), tone: "amber" },
    { label: "停用", value: channels.disabled, percent: Math.round((channels.disabled / total) * 100), tone: "dim" },
  ];
});

const facts = computed(() => {
  const value = data.value;
  if (!value) {
    return [];
  }
  return [
    { label: "在线宿主", value: value.hosts.alive + " / " + value.hosts.total },
    { label: "活跃设备（24h）", value: value.devices.active24h + " / " + value.devices.total },
    { label: "可用入场码", value: String(value.codes.active) },
    { label: "模型密钥", value: String(value.llm.keys) },
    { label: "管理员", value: value.users.admins + " / " + value.users.total },
    { label: "7 天审计动作", value: String(value.audit.total7d) },
  ];
});

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="page">
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false">
      <template #default>
        <el-button link type="primary" @click="load">重试</el-button>
      </template>
    </el-alert>

    <template v-if="data">
      <div class="stat-grid">
        <StatCard
          label="用户"
          :value="formatNumber(data.users.total)"
          :hint="'今日 +' + data.users.newToday + ' · 7 天 +' + data.users.new7d + ' · 管理员 ' + data.users.admins"
          tone="blue"
        >
          <template #icon
            ><el-icon><User /></el-icon
          ></template>
        </StatCard>
        <StatCard
          label="宿主在线"
          :value="data.hosts.alive + ' / ' + data.hosts.total"
          :hint="'通道绑定 ' + data.hosts.bindings + ' 条'"
          tone="mint"
        >
          <template #icon
            ><el-icon><Monitor /></el-icon
          ></template>
        </StatCard>
        <StatCard
          label="通道异常"
          :value="String(data.channels.degraded + data.channels.disabled)"
          :hint="'正常 ' + data.channels.active + ' · 降级 ' + data.channels.degraded + ' · 停用 ' + data.channels.disabled"
          :tone="data.channels.degraded > 0 ? 'amber' : 'mint'"
        >
          <template #icon
            ><el-icon><Warning /></el-icon
          ></template>
        </StatCard>
        <StatCard
          label="今日 Token"
          :value="formatTokens(data.llm.tokensToday)"
          :hint="'7 天 ' + formatTokens(data.llm.tokens7d) + ' · 请求 ' + formatNumber(data.llm.requests7d)"
          tone="violet"
        >
          <template #icon
            ><el-icon><Cpu /></el-icon
          ></template>
        </StatCard>
        <StatCard
          label="今日审计动作"
          :value="String(data.audit.today)"
          :hint="'可用入场码 ' + data.codes.active + ' · 今日签发 ' + data.codes.issuedToday"
          tone="amber"
        >
          <template #icon
            ><el-icon><Tickets /></el-icon
          ></template>
        </StatCard>
      </div>

      <div class="grid-2">
        <section class="gw-card">
          <header>
            <h3>近 7 天趋势</h3>
            <span class="gw-dim">新增用户 · 审计动作 · 模型请求</span>
          </header>
          <TrendBars :points="data.trend" />
        </section>

        <section class="gw-card">
          <header>
            <h3>通道状态</h3>
            <span class="gw-dim">共 {{ data.channels.total }} 条绑定</span>
          </header>
          <div v-if="data.channels.total" class="channel-list">
            <div v-for="row in channelRows" :key="row.label" class="channel-row">
              <div class="channel-head">
                <span :data-tone="row.tone">{{ row.label }}</span>
                <b>{{ row.value }}</b>
              </div>
              <el-progress
                :percentage="row.percent"
                :show-text="false"
                :stroke-width="6"
                :color="row.tone === 'mint' ? '#3fb950' : row.tone === 'amber' ? '#d29922' : '#6e7681'"
              />
            </div>
          </div>
          <div v-else class="gw-empty">还没有通道绑定</div>

          <h4>运行概况</h4>
          <dl class="facts">
            <div v-for="fact in facts" :key="fact.label">
              <dt>{{ fact.label }}</dt>
              <dd>{{ fact.value }}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section class="gw-card">
        <header>
          <h3>最近运维动作</h3>
          <span class="gw-dim">生成于 {{ formatDateTime(data.generatedAt) }}</span>
        </header>
        <el-timeline v-if="data.recentAudits.length" class="timeline">
          <el-timeline-item
            v-for="log in data.recentAudits"
            :key="log.id"
            :timestamp="formatDateTime(log.createdAt)"
            placement="top"
            :color="actionMeta(log.action).tone === 'danger' ? '#f85149' : '#58a6ff'"
          >
            <div class="audit-line">
              <el-tag :type="actionMeta(log.action).tone" size="small" effect="plain">
                {{ actionMeta(log.action).label }}
              </el-tag>
              <span class="gw-dim">{{ log.actorEmail }}</span>
              <span v-if="log.targetType" class="gw-mono target">
                {{ log.targetType }}<template v-if="log.targetId">#{{ log.targetId }}</template>
              </span>
              <span v-if="log.detail" class="gw-dim detail">{{ log.detail }}</span>
            </div>
          </el-timeline-item>
        </el-timeline>
        <div v-else class="gw-empty">还没有运维动作记录</div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.channel-list {
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.channel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 5px;
  font-size: 12px;
}

.channel-head span[data-tone="mint"] {
  color: var(--gw-mint);
}
.channel-head span[data-tone="amber"] {
  color: var(--gw-amber);
}
.channel-head span[data-tone="dim"] {
  color: var(--gw-dim);
}

.channel-head b {
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 16px;
  margin: 0;
}

.facts div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--gw-line-soft);
}

.facts dt {
  color: var(--gw-dim);
  font-size: 11.5px;
}

.facts dd {
  margin: 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.timeline {
  padding-left: 2px;
}

.audit-line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
}

.target {
  color: #7d8794;
}

.detail {
  font-size: 11.5px;
}
</style>
