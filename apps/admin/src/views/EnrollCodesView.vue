<script setup lang="ts">
import { CopyDocument, Plus, Refresh } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { onMounted, ref } from "vue";
import { adminApi } from "../api";
import { ApiError } from "../api/http";
import type { EnrollCodeItem, IssuedCode } from "../types";
import { copyText } from "../utils/clipboard";
import { formatDateTime } from "../utils/format";

const codes = ref<EnrollCodeItem[]>([]);
const loading = ref(false);
const issuing = ref(false);
const hours = ref(24);
const issued = ref<IssuedCode | null>(null);

const HOUR_OPTIONS = [
  { value: 1, label: "1 小时" },
  { value: 24, label: "24 小时" },
  { value: 168, label: "7 天" },
  { value: 720, label: "30 天" },
];

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    codes.value = await adminApi.enrollCodes();
  } catch (err) {
    ElMessage.error(messageOf(err, "入场码加载失败"));
  } finally {
    loading.value = false;
  }
}

async function issue(): Promise<void> {
  issuing.value = true;
  try {
    issued.value = await adminApi.issueEnrollCode(hours.value);
    ElMessage.success("入场码已签发");
    await load();
  } catch (err) {
    ElMessage.error(messageOf(err, "签发失败"));
  } finally {
    issuing.value = false;
  }
}

async function copy(): Promise<void> {
  if (!issued.value) {
    return;
  }
  if (copyText(issued.value.code)) {
    ElMessage.success("已复制到剪贴板");
  } else {
    ElMessage.warning("复制失败，请手动选中复制");
  }
}

async function revoke(row: EnrollCodeItem): Promise<void> {
  try {
    await ElMessageBox.confirm("撤销后这个码立即作废，且无法恢复。", "撤销入场码", {
      confirmButtonText: "撤销",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }
  try {
    await adminApi.revokeEnrollCode(row.id);
    ElMessage.success("已撤销");
    await load();
  } catch (err) {
    ElMessage.error(messageOf(err, "撤销失败"));
  }
}

function statusType(status: string): "success" | "warning" | "danger" | "info" {
  if (status === "active") {
    return "success";
  }
  if (status === "expired") {
    return "warning";
  }
  if (status === "used") {
    return "info";
  }
  return "danger";
}

function statusLabel(status: string): string {
  return { active: "可用", expired: "已过期", used: "已使用" }[status] ?? status;
}

onMounted(load);
</script>

<template>
  <div class="page">
    <section class="gw-card">
      <header>
        <h3>签发入场码</h3>
        <span class="gw-dim">明文只显示一次，库里存 sha256</span>
      </header>
      <div class="gw-toolbar">
        <el-select v-model="hours" style="width: 140px">
          <el-option v-for="option in HOUR_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-button type="primary" :icon="Plus" :loading="issuing" @click="issue">签发新码</el-button>
        <el-button :icon="Refresh" @click="load">刷新列表</el-button>
        <span class="spacer" />
        <span class="gw-dim">入场码用于新设备首次登录，用一次即失效</span>
      </div>

      <transition name="fade">
        <div v-if="issued" class="issued">
          <div class="issued-top">
            <span>新入场码（请立即发送给使用者）</span>
            <el-tag size="small" effect="plain" type="success">{{
              issued.item.expiresAt ? formatDateTime(issued.item.expiresAt) + " 过期" : ""
            }}</el-tag>
          </div>
          <div class="issued-code">
            <code>{{ issued.code }}</code>
            <el-button :icon="CopyDocument" @click="copy">复制</el-button>
          </div>
          <p>关闭提示后明文不再可见；如果丢了，只能重新签发。</p>
        </div>
      </transition>
    </section>

    <section class="gw-card">
      <header>
        <h3>最近入场码</h3>
        <span class="gw-dim">共 {{ codes.length }} 条（最多 100）</span>
      </header>
      <el-table v-loading="loading" :data="codes" empty-text="还没有入场码">
        <el-table-column label="哈希前缀" width="130">
          <template #default="{ row }">
            <span class="gw-mono">{{ row.hashPrefix }}…</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small" effect="plain">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="过期时间" width="180">
          <template #default="{ row }">
            <span class="gw-dim">{{ formatDateTime(row.expiresAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="使用时间" width="180">
          <template #default="{ row }">
            <span class="gw-dim">{{ formatDateTime(row.usedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="签发时间" min-width="180">
          <template #default="{ row }">
            <span class="gw-dim">{{ formatDateTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'active'" link type="danger" @click="revoke(row)">撤销</el-button>
            <span v-else class="gw-dim">—</span>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>

<style scoped>
.issued {
  margin-top: 16px;
  padding: 14px 16px;
  border: 1px dashed #36506b;
  border-radius: 10px;
  background: linear-gradient(120deg, rgba(88, 166, 255, 0.1), rgba(88, 166, 255, 0.02));
}

.issued-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--gw-dim);
  font-size: 12px;
}

.issued-code {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}

.issued-code code {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border-radius: 7px;
  background: #0b1017;
  border: 1px solid var(--gw-line);
  color: var(--gw-accent);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 15px;
  letter-spacing: 0.06em;
  overflow-x: auto;
  white-space: nowrap;
}

.issued p {
  margin: 9px 0 0;
  color: #6e7681;
  font-size: 11px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
