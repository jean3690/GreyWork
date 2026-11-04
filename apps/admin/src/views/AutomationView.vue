<script setup lang="ts">
import { Refresh } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { adminApi } from "../api";
import { ApiError } from "../api/http";
import StatCard from "../components/StatCard.vue";
import type { AutomationOverview } from "../types";
import { formatDateTime, formatNumber } from "../utils/format";

const data = ref<AutomationOverview | null>(null);
const loading = ref(false);

/** 失败率比失败条数更能说明问题：量大的时候 3 条失败可能完全正常。 */
const failureRate = computed(() => {
  const runs = data.value?.runs7d ?? 0;
  const failed = data.value?.runsFailed7d ?? 0;
  if (!runs) {
    return "—";
  }
  return Math.round((failed / runs) * 100) + "%";
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await adminApi.automation();
  } catch (err) {
    ElMessage.error(err instanceof ApiError ? err.message : "自动化数据加载失败");
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="page">
    <div class="stat-grid">
      <StatCard label="任务数" :value="formatNumber(data?.tasks)" :hint="'启用中 ' + formatNumber(data?.enabled)" tone="blue" />
      <StatCard label="待触发积压" :value="formatNumber(data?.duePending)" hint="已入队还没被认领" tone="amber" />
      <StatCard label="逾期未认领" :value="formatNumber(data?.dueOverdue)" hint="过了触发时间仍是 pending" tone="red" />
      <StatCard
        label="7 天执行 / 失败率"
        :value="formatNumber(data?.runs7d)"
        :hint="'失败 ' + formatNumber(data?.runsFailed7d) + '（' + failureRate + '）'"
        tone="mint"
      />
    </div>

    <section class="gw-card">
      <header>
        <h3>最近任务</h3>
        <el-button :icon="Refresh" size="small" @click="load">刷新</el-button>
      </header>
      <el-table :data="data?.recent ?? []" empty-text="还没有自动化任务">
        <el-table-column label="任务" min-width="180">
          <template #default="{ row }">
            <span>{{ row.name || row.id }}</span>
            <span class="gw-mono gw-dim task-id">{{ row.id }}</span>
          </template>
        </el-table-column>
        <el-table-column label="归属" min-width="180">
          <template #default="{ row }">
            <span class="gw-dim">{{ row.ownerEmail || "未知用户" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="执行方" width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" type="info">
              {{ row.execution === "cloud" ? "云端" : "宿主" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small" effect="plain">
              {{ row.enabled ? "启用" : "停用" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="下次触发" width="170">
          <template #default="{ row }">
            <span class="gw-dim">{{ formatDateTime(row.nextRunAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="上次运行" width="170">
          <template #default="{ row }">
            <span class="gw-dim">{{ formatDateTime(row.lastRunAt) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section class="gw-card">
      <header>
        <h3>口径说明</h3>
      </header>
      <ul class="notes">
        <li>「逾期未认领」是判断调度是否卡住的主指标；正常积压只差几分钟。</li>
        <li>软删（deleted_at）的任务不计入任务数；停用任务仍计入，只是不会入队。</li>
        <li>执行数取最近 7 天的 automation_run，云端与宿主执行共用一张表。</li>
        <li>运维台不提供「改别人的任务」：停用任务属于用户自己的编排，出事优先禁用账号。</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.task-id {
  display: block;
  margin-top: 2px;
  font-size: 10.5px;
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
