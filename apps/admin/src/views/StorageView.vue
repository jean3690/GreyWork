<script setup lang="ts">
import { Refresh } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { adminApi } from "../api";
import { ApiError } from "../api/http";
import StatCard from "../components/StatCard.vue";
import type { StorageOverview } from "../types";
import { formatBytes, formatDateTime, formatNumber } from "../utils/format";

const data = ref<StorageOverview | null>(null);
const loading = ref(false);

/** 种类占比按容量算（运维关心的是「谁占空间」，不是「谁文件多」）。 */
const kindRows = computed(() => {
  const list = data.value?.byKind ?? [];
  const max = Math.max(1, ...list.map((row) => row.bytes));
  return list.map((row) => ({
    ...row,
    percent: Math.round((row.bytes / max) * 100),
  }));
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await adminApi.storage();
  } catch (err) {
    ElMessage.error(err instanceof ApiError ? err.message : "存储数据加载失败");
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="page">
    <div class="stat-grid">
      <StatCard label="对象数" :value="formatNumber(data?.objects)" hint="仅统计已确认上传（ready）" tone="blue" />
      <StatCard label="占用容量" :value="formatBytes(data?.bytes)" hint="S3 正文的实际记账字节数" tone="violet" />
      <StatCard label="待确认上传" :value="formatNumber(data?.pending)" hint="签了票据但没回执，超时会被清理" tone="amber" />
      <StatCard label="种类" :value="formatNumber(kindRows.length)" hint="image / file / artifact …" tone="mint" />
    </div>

    <div class="grid-2">
      <section class="gw-card">
        <header>
          <h3>容量分布</h3>
          <span class="gw-dim">按种类 · 容量排序</span>
        </header>
        <div v-if="kindRows.length" class="kinds">
          <div v-for="row in kindRows" :key="row.kind" class="kind">
            <div class="kind-head">
              <span>{{ row.kind || "未分类" }}</span>
              <b>{{ formatBytes(row.bytes) }} · {{ formatNumber(row.objects) }} 个</b>
            </div>
            <el-progress :percentage="row.percent" :show-text="false" :stroke-width="7" color="#4d9fff" />
          </div>
        </div>
        <div v-else class="gw-empty">还没有已确认上传的对象</div>
      </section>

      <section class="gw-card">
        <header>
          <h3>口径说明</h3>
        </header>
        <ul class="notes">
          <li>容量只算 status=ready；pending 是「已签发票据但没确认上传」的空壳，单独计数。</li>
          <li>正文在对象存储（S3 / RustFS），这里只是元数据记账，不下发任何下载链接。</li>
          <li>运维台是只读视角：删除对象、改可见性仍由用户在客户端操作。</li>
          <li>要一次性掐断某个用户对外行为，去「用户与设备」禁用账号，而不是逐个删资源。</li>
        </ul>
      </section>
    </div>

    <section class="gw-card">
      <header>
        <h3>最近对象</h3>
        <el-button :icon="Refresh" size="small" @click="load">刷新</el-button>
      </header>
      <el-table :data="data?.recent ?? []" empty-text="还没有对象">
        <el-table-column label="名称" min-width="200">
          <template #default="{ row }">
            <span class="gw-mono">{{ row.name || "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="归属" min-width="180">
          <template #default="{ row }">
            <span class="gw-dim">{{ row.ownerEmail || "未知用户" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="种类" width="100">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" type="info">{{ row.kind || "—" }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="110" align="right">
          <template #default="{ row }">
            <span class="gw-mono gw-dim">{{ formatBytes(row.sizeBytes) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="可见性" width="100">
          <template #default="{ row }">
            <el-tag :type="row.visibility === 'public' ? 'warning' : 'info'" size="small" effect="plain">
              {{ row.visibility === "public" ? "公开" : "私有" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'ready' ? 'success' : 'info'" size="small" effect="plain">
              {{ row.status === "ready" ? "可用" : "待确认" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="上传时间" width="170">
          <template #default="{ row }">
            <span class="gw-dim">{{ formatDateTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>

<style scoped>
.kinds {
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.kind-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
  font-size: 12px;
}

.kind-head b {
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
