<script setup lang="ts">
import { Refresh } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { adminApi } from "../api";
import { ApiError } from "../api/http";
import StatCard from "../components/StatCard.vue";
import type { HostItem } from "../types";
import { formatDateTime, formatNumber } from "../utils/format";

const rows = ref<HostItem[]>([]);
const loading = ref(false);

const alive = computed(() => rows.value.filter((row) => row.alive).length);
const bindings = computed(() => rows.value.reduce((sum, row) => sum + row.bindings, 0));

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await adminApi.hosts();
  } catch (err) {
    ElMessage.error(err instanceof ApiError ? err.message : "宿主列表加载失败");
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="stat-grid">
      <StatCard label="宿主总数" :value="formatNumber(rows.length)" hint="已注册的桌面端 / 服务端实例" tone="blue" />
      <StatCard label="在线" :value="formatNumber(alive)" :hint="'心跳 90 秒内有效'" tone="mint" />
      <StatCard label="承载通道" :value="formatNumber(bindings)" hint="落在这些宿主上的绑定数" tone="violet" />
      <StatCard
        label="离线"
        :value="formatNumber(rows.length - alive)"
        :hint="rows.length - alive > 0 ? '离线时通道会降级或接管' : '全部在线'"
        :tone="rows.length - alive > 0 ? 'amber' : 'mint'"
      />
    </div>

    <section class="gw-card">
      <header>
        <h3>宿主实例</h3>
        <el-button :icon="Refresh" size="small" @click="load">刷新</el-button>
      </header>
      <el-table v-loading="loading" :data="rows" empty-text="还没有宿主注册">
        <el-table-column label="宿主" min-width="180">
          <template #default="{ row }">
            <div class="cell-stack">
              <b>{{ row.name || "未命名宿主" }}</b>
              <span class="gw-mono">{{ row.deviceId }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="归属" min-width="180">
          <template #default="{ row }">
            <span class="gw-dim">{{ row.ownerEmail || "未知用户" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="版本" width="120">
          <template #default="{ row }">
            <span class="gw-mono gw-dim">{{ row.version || "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="通道" width="80">
          <template #default="{ row }">{{ row.bindings }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.alive ? 'success' : 'info'" size="small" effect="plain">
              {{ row.alive ? "在线" : "离线" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="注册时间" width="180">
          <template #default="{ row }">
            <span class="gw-dim">{{ formatDateTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>

<style scoped>
.cell-stack {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

.cell-stack b {
  font-weight: 500;
  font-size: 12.5px;
}

.cell-stack span {
  color: #6e7681;
  font-size: 10.5px;
}
</style>
