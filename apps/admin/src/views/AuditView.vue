<script setup lang="ts">
import { Refresh, Search } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { onMounted, ref } from "vue";
import { adminApi } from "../api";
import { ApiError } from "../api/http";
import type { AuditLog } from "../types";
import { actionMeta, formatDateTime } from "../utils/format";

const rows = ref<AuditLog[]>([]);
const loading = ref(false);
const targetType = ref("");
const targetId = ref<string>("");
const limit = ref(50);
const page = ref(0);

const TARGET_TYPES = [
  { value: "", label: "全部目标" },
  { value: "user", label: "用户" },
  { value: "device", label: "设备" },
  { value: "enroll_code", label: "入场码" },
  { value: "channel", label: "通道" },
];

async function load(resetPage = false): Promise<void> {
  if (resetPage) {
    page.value = 0;
  }
  loading.value = true;
  try {
    const parsedId = targetId.value.trim() ? Number(targetId.value.trim()) : undefined;
    rows.value = await adminApi.audit({
      targetType: targetType.value || undefined,
      targetId: Number.isFinite(parsedId) ? parsedId : undefined,
      limit: limit.value,
      offset: page.value * limit.value,
    });
  } catch (err) {
    ElMessage.error(err instanceof ApiError ? err.message : "审计日志加载失败");
  } finally {
    loading.value = false;
  }
}

function nextPage(): void {
  if (rows.value.length < limit.value) {
    return;
  }
  page.value += 1;
  void load();
}

function prevPage(): void {
  if (page.value === 0) {
    return;
  }
  page.value -= 1;
  void load();
}

onMounted(() => load());
</script>

<template>
  <div class="page">
    <section class="gw-card">
      <header>
        <h3>审计日志</h3>
        <span class="gw-dim">按时间倒序 · 第 {{ page + 1 }} 页</span>
      </header>

      <div class="gw-toolbar">
        <el-select v-model="targetType" placeholder="全部目标" style="width: 140px" @change="load(true)">
          <el-option v-for="item in TARGET_TYPES" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-input v-model="targetId" placeholder="目标 ID" style="width: 140px" clearable @keyup.enter="load(true)" />
        <el-select v-model="limit" style="width: 110px" @change="load(true)">
          <el-option :value="20" label="每页 20" />
          <el-option :value="50" label="每页 50" />
          <el-option :value="100" label="每页 100" />
        </el-select>
        <el-button type="primary" :icon="Search" @click="load(true)">查询</el-button>
        <el-button :icon="Refresh" @click="load()">刷新</el-button>
      </div>

      <el-table v-loading="loading" :data="rows" style="margin-top: 12px" empty-text="没有匹配的审计记录">
        <el-table-column label="时间" width="180">
          <template #default="{ row }">
            <span class="gw-dim">{{ formatDateTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="动作" width="130">
          <template #default="{ row }">
            <el-tag :type="actionMeta(row.action).tone" size="small" effect="plain">
              {{ actionMeta(row.action).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作者" min-width="180">
          <template #default="{ row }">
            <span>{{ row.actorEmail }}</span>
          </template>
        </el-table-column>
        <el-table-column label="目标" width="150">
          <template #default="{ row }">
            <span class="gw-mono gw-dim">
              {{ row.targetType }}<template v-if="row.targetId">#{{ row.targetId }}</template>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="详情" min-width="220">
          <template #default="{ row }">
            <span class="gw-mono gw-dim">{{ row.detail || "—" }}</span>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-button size="small" :disabled="page === 0" @click="prevPage">上一页</el-button>
        <span class="gw-dim">每页 {{ limit }} 条</span>
        <el-button size="small" :disabled="rows.length < limit" @click="nextPage">下一页</el-button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 14px;
  font-size: 11.5px;
}
</style>
