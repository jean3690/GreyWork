<script setup lang="ts">
import { Refresh, Search } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { onMounted, ref } from "vue";
import { adminApi } from "../api";
import { ApiError } from "../api/http";
import { useAuthStore } from "../stores/auth";
import type { DeviceItem, UserDetail, UserItem } from "../types";
import { formatDateTime, platformLabel } from "../utils/format";

const auth = useAuthStore();

const rows = ref<UserItem[]>([]);
const query = ref("");
const loading = ref(false);
const error = ref("");

const drawer = ref(false);
const detailLoading = ref(false);
const detail = ref<UserDetail | null>(null);
const devices = ref<DeviceItem[]>([]);
const currentId = ref<number | null>(null);

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await adminApi.users(query.value.trim() || undefined, 100);
  } catch (err) {
    error.value = messageOf(err, "用户列表加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadDetail(id: number): Promise<void> {
  detailLoading.value = true;
  try {
    const [info, list] = await Promise.all([adminApi.userDetail(id), adminApi.userDevices(id)]);
    detail.value = info;
    devices.value = list;
  } catch (err) {
    ElMessage.error(messageOf(err, "用户详情加载失败"));
  } finally {
    detailLoading.value = false;
  }
}

async function openDetail(row: UserItem): Promise<void> {
  currentId.value = row.id;
  detail.value = null;
  devices.value = [];
  drawer.value = true;
  await loadDetail(row.id);
}

async function toggleStatus(row: UserItem): Promise<void> {
  const next = row.status === "active" ? "disabled" : "active";
  try {
    await ElMessageBox.confirm(
      next === "disabled" ? "禁用后该用户立即无法登录，且现有会话会被全部吊销。" : "启用后该用户可以重新登录。",
      (next === "disabled" ? "禁用 " : "启用 ") + row.email,
      { confirmButtonText: "确认", cancelButtonText: "取消", type: next === "disabled" ? "warning" : "info" },
    );
  } catch {
    return;
  }
  try {
    await adminApi.updateUser(row.id, { status: next });
    ElMessage.success(next === "disabled" ? "已禁用" : "已启用");
    await load();
    if (currentId.value === row.id) {
      await loadDetail(row.id);
    }
  } catch (err) {
    ElMessage.error(messageOf(err, "操作失败"));
  }
}

async function toggleRole(row: UserItem): Promise<void> {
  const next = row.role === "admin" ? "user" : "admin";
  try {
    await ElMessageBox.confirm(
      next === "admin" ? "提为管理员后，该账号可以访问整个运维台。" : "降为普通用户后，该账号将无法进入运维台。",
      (next === "admin" ? "设为管理员：" : "取消管理员：") + row.email,
      { confirmButtonText: "确认", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }
  try {
    await adminApi.updateUser(row.id, { role: next });
    ElMessage.success(next === "admin" ? "已设为管理员" : "已降为普通用户");
    await load();
  } catch (err) {
    ElMessage.error(messageOf(err, "操作失败"));
  }
}

async function kick(row: UserItem): Promise<void> {
  try {
    await ElMessageBox.confirm("只清理登录会话，账号仍然可用（用户下次登录即可）。", "踢下线：" + row.email, {
      confirmButtonText: "踢下线",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }
  try {
    const result = await adminApi.revokeSessions(row.id);
    ElMessage.success("已清理 " + result.devices + " 台设备的会话");
    if (currentId.value === row.id) {
      await loadDetail(row.id);
    }
  } catch (err) {
    ElMessage.error(messageOf(err, "操作失败"));
  }
}

async function revokeDevice(device: DeviceItem): Promise<void> {
  if (!currentId.value) {
    return;
  }
  try {
    await ElMessageBox.confirm("吊销后这台设备需要重新登录。", "吊销设备：" + device.name, {
      confirmButtonText: "吊销",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }
  try {
    await adminApi.revokeDevice(currentId.value, device.id);
    ElMessage.success("设备已吊销");
    await loadDetail(currentId.value);
    await load();
  } catch (err) {
    ElMessage.error(messageOf(err, "操作失败"));
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />

    <section class="gw-card">
      <div class="gw-toolbar">
        <el-input v-model="query" placeholder="按邮箱或昵称搜索" clearable style="width: 280px" @keyup.enter="load" @clear="load">
          <template #prefix
            ><el-icon><Search /></el-icon
          ></template>
        </el-input>
        <el-button type="primary" @click="load">搜索</el-button>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <span class="spacer" />
        <span class="gw-dim">共 {{ rows.length }} 个账号（最多显示 100）</span>
      </div>

      <el-table v-loading="loading" :data="rows" style="margin-top: 12px" empty-text="没有匹配的账号">
        <el-table-column label="账号" min-width="220">
          <template #default="{ row }">
            <div class="cell-stack">
              <b>{{ row.email }}</b>
              <span class="gw-dim">{{ row.displayName || "—" }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="96">
          <template #default="{ row }">
            <el-tag :type="row.role === 'admin' ? 'warning' : 'info'" size="small" effect="plain">
              {{ row.role === "admin" ? "管理员" : "普通用户" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'danger'" size="small" effect="plain">
              {{ row.status === "active" ? "正常" : "已禁用" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="注册时间" width="170">
          <template #default="{ row }">
            <span class="gw-dim">{{ formatDateTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button link :type="row.status === 'active' ? 'danger' : 'success'" @click="toggleStatus(row)">
              {{ row.status === "active" ? "禁用" : "启用" }}
            </el-button>
            <el-button v-if="row.id !== auth.user?.id" link type="warning" @click="toggleRole(row)">
              {{ row.role === "admin" ? "取消管理员" : "设为管理员" }}
            </el-button>
            <el-button link type="info" @click="kick(row)">踢下线</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-drawer v-model="drawer" size="560px" :title="detail?.email || '用户详情'">
      <div v-loading="detailLoading" class="drawer-body">
        <template v-if="detail">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="昵称">{{ detail.displayName || "—" }}</el-descriptions-item>
            <el-descriptions-item label="角色">
              {{ detail.role === "admin" ? "管理员" : "普通用户" }}
            </el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag :type="detail.status === 'active' ? 'success' : 'danger'" size="small" effect="plain">
                {{ detail.status === "active" ? "正常" : "已禁用" }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="注册来源">
              {{ detail.providers.length ? detail.providers.join(" / ") : "入场码" }}
            </el-descriptions-item>
            <el-descriptions-item label="设备数">{{ detail.deviceCount }}</el-descriptions-item>
            <el-descriptions-item label="最近活跃">{{ formatDateTime(detail.lastActiveAt) }}</el-descriptions-item>
            <el-descriptions-item label="注册时间" :span="2">{{ formatDateTime(detail.createdAt) }}</el-descriptions-item>
          </el-descriptions>

          <h4>设备</h4>
          <el-table :data="devices" size="small" empty-text="该账号还没有设备">
            <el-table-column prop="name" label="名称" min-width="110" />
            <el-table-column label="平台" width="90">
              <template #default="{ row }">{{ platformLabel(row.platform) }}</template>
            </el-table-column>
            <el-table-column label="最后活跃" width="150">
              <template #default="{ row }">
                <span class="gw-dim">{{ formatDateTime(row.lastSeenAt) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80" fixed="right">
              <template #default="{ row }">
                <el-button link type="danger" @click="revokeDevice(row)">吊销</el-button>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </div>
    </el-drawer>
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
  font-size: 11px;
}

.drawer-body {
  min-height: 120px;
}

.drawer-body h4 {
  margin: 22px 0 10px;
  font-size: 12.5px;
  color: var(--gw-dim);
  font-weight: 600;
}
</style>
