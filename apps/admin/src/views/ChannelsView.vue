<script setup lang="ts">
import { Refresh } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { adminApi } from "../api";
import { ApiError } from "../api/http";
import type { ChannelItem } from "../types";
import { formatDateTime, platformLabel } from "../utils/format";

const rows = ref<ChannelItem[]>([]);
const loading = ref(false);
const filter = ref<"all" | "active" | "degraded" | "disabled">("all");

const visible = computed(() => (filter.value === "all" ? rows.value : rows.value.filter((row) => row.status === filter.value)));
const counts = computed(() => ({
  all: rows.value.length,
  active: rows.value.filter((row) => row.status === "active").length,
  degraded: rows.value.filter((row) => row.status === "degraded").length,
  disabled: rows.value.filter((row) => row.status === "disabled").length,
}));

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await adminApi.channels();
  } catch (err) {
    ElMessage.error(err instanceof ApiError ? err.message : "通道列表加载失败");
  } finally {
    loading.value = false;
  }
}

async function toggle(row: ChannelItem): Promise<void> {
  const next = row.storedStatus === "disabled" ? "active" : "disabled";
  const verb = next === "disabled" ? "停用" : "启用";
  try {
    await ElMessageBox.confirm(
      next === "disabled" ? "停用后平台 webhook 会被拒绝（返回 409），直到重新启用。" : "启用后平台消息会重新进入宿主。",
      verb + "通道：" + platformLabel(row.platform) + " / " + row.accountRef,
      { confirmButtonText: verb, cancelButtonText: "取消", type: next === "disabled" ? "warning" : "info" },
    );
  } catch {
    return;
  }
  try {
    await adminApi.setChannelStatus(row.id, next);
    ElMessage.success("已" + verb);
    await load();
  } catch (err) {
    ElMessage.error(err instanceof ApiError ? err.message : verb + "失败");
  }
}

function statusType(status: string): "success" | "warning" | "info" {
  if (status === "active") {
    return "success";
  }
  return status === "degraded" ? "warning" : "info";
}

function statusLabel(status: string): string {
  return ({ active: "正常", degraded: "降级", disabled: "已停用" } as Record<string, string>)[status] ?? status;
}

onMounted(load);
</script>

<template>
  <div class="page">
    <section class="gw-card">
      <header>
        <h3>通道绑定</h3>
        <el-button :icon="Refresh" size="small" @click="load">刷新</el-button>
      </header>

      <div class="gw-toolbar">
        <el-radio-group v-model="filter" size="small">
          <el-radio-button value="all">全部 {{ counts.all }}</el-radio-button>
          <el-radio-button value="active">正常 {{ counts.active }}</el-radio-button>
          <el-radio-button value="degraded">降级 {{ counts.degraded }}</el-radio-button>
          <el-radio-button value="disabled">停用 {{ counts.disabled }}</el-radio-button>
        </el-radio-group>
        <span class="spacer" />
        <span class="gw-dim">降级 = 宿主不在线；停用 = 管理员硬开关</span>
      </div>

      <el-table v-loading="loading" :data="visible" style="margin-top: 12px" empty-text="没有匹配的通道">
        <el-table-column label="平台" width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" type="info">{{ platformLabel(row.platform) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="账号" min-width="180">
          <template #default="{ row }">
            <span class="gw-mono">{{ row.accountRef }}</span>
          </template>
        </el-table-column>
        <el-table-column label="归属" min-width="180">
          <template #default="{ row }">
            <span class="gw-dim">{{ row.ownerEmail || "未知用户" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="宿主" min-width="160">
          <template #default="{ row }">
            <span class="gw-dim">{{ row.hostName || "未分配" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="96">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small" effect="plain">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="180">
          <template #default="{ row }">
            <span class="gw-dim">{{ formatDateTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link :type="row.storedStatus === 'disabled' ? 'success' : 'danger'" @click="toggle(row)">
              {{ row.storedStatus === "disabled" ? "启用" : "停用" }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>
