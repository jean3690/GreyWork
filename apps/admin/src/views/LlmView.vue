<script setup lang="ts">
import { Refresh } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { adminApi } from "../api";
import { ApiError } from "../api/http";
import StatCard from "../components/StatCard.vue";
import type { LlmKeyItem, LlmUsageOverview } from "../types";
import { formatDateTime, formatNumber, formatTokens } from "../utils/format";

const keys = ref<LlmKeyItem[]>([]);
const usage = ref<LlmUsageOverview | null>(null);
const loading = ref(false);

const providerRows = computed(() => {
  const list = usage.value?.byProvider ?? [];
  const max = Math.max(1, ...list.map((row) => row.tokens));
  return list.map((row) => ({
    ...row,
    percent: Math.round((row.tokens / max) * 100),
  }));
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [keyList, usageData] = await Promise.all([adminApi.llmKeys(), adminApi.llmUsage()]);
    keys.value = keyList;
    usage.value = usageData;
  } catch (err) {
    ElMessage.error(err instanceof ApiError ? err.message : "模型数据加载失败");
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="page">
    <div class="stat-grid">
      <StatCard label="密钥条目" :value="formatNumber(keys.length)" hint="只显示元数据，密文永不出库" tone="blue" />
      <StatCard
        label="7 天请求"
        :value="formatNumber(usage?.requests7d)"
        :hint="'今日 ' + formatNumber(usage?.requestsToday)"
        tone="violet"
      />
      <StatCard label="7 天 Token" :value="formatTokens(usage?.tokens7d)" :hint="'今日 ' + formatTokens(usage?.tokensToday)" tone="mint" />
      <StatCard
        label="每请求均耗"
        :value="usage && usage.requests7d > 0 ? formatTokens(Math.round(usage.tokens7d / usage.requests7d)) : '—'"
        hint="仅统计网关转发的 /chat/completions"
        tone="amber"
      />
    </div>

    <div class="grid-2">
      <section class="gw-card">
        <header>
          <h3>供应商用量（7 天）</h3>
          <span class="gw-dim">按 token 排序</span>
        </header>
        <div v-if="providerRows.length" class="providers">
          <div v-for="row in providerRows" :key="row.provider" class="provider">
            <div class="provider-head">
              <span>{{ row.provider }}</span>
              <b>{{ formatTokens(row.tokens) }} token · {{ formatNumber(row.requests) }} 次</b>
            </div>
            <el-progress :percentage="row.percent" :show-text="false" :stroke-width="7" color="#a371f7" />
          </div>
        </div>
        <div v-else class="gw-empty">近 7 天没有模型调用</div>
      </section>

      <section class="gw-card">
        <header>
          <h3>说明</h3>
        </header>
        <ul class="notes">
          <li>密钥由用户在自己的设置里添加，服务端以 AES-GCM 密文存储。</li>
          <li>这里只做运维视角的只读观察，不提供查看或导出明文密钥的入口。</li>
          <li>用量来自网关转发记录；直连供应商（客户端自带 key）不计入。</li>
          <li>限额：每分钟请求数与每日 token 上限由环境变量控制。</li>
        </ul>
      </section>
    </div>

    <section class="gw-card">
      <header>
        <h3>模型密钥</h3>
        <el-button :icon="Refresh" size="small" @click="load">刷新</el-button>
      </header>
      <el-table :data="keys" empty-text="还没有用户添加密钥">
        <el-table-column label="供应商" width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" type="info">{{ row.provider }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="label" label="标签" width="130" />
        <el-table-column label="归属" min-width="180">
          <template #default="{ row }">
            <span class="gw-dim">{{ row.ownerEmail || "未知用户" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="Base URL" min-width="220">
          <template #default="{ row }">
            <span class="gw-mono gw-dim">{{ row.baseUrl }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small" effect="plain">
              {{ row.status === "active" ? "可用" : row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最后使用" width="170">
          <template #default="{ row }">
            <span class="gw-dim">{{ formatDateTime(row.lastUsedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">
            <span class="gw-dim">{{ formatDateTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>

<style scoped>
.providers {
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.provider-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
  font-size: 12px;
}

.provider-head b {
  color: var(--gw-dim);
  font-weight: 400;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.notes {
  margin: 0;
  padding-left: 18px;
  color: var(--gw-dim);
  font-size: 12px;
  line-height: 1.9;
}

.notes li::marker {
  color: #4b5563;
}
</style>
