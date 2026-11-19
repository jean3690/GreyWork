<script setup lang="ts">
import { Refresh, Search } from "@element-plus/icons-vue";
import { useAuthStore } from "../stores/auth";
import { useUserManagement } from "../composables/useUserManagement";
import { formatDateTime } from "../utils/format";
import UserDetailDrawer from "../components/users/UserDetailDrawer.vue";

const auth = useAuthStore();

const {
  rows,
  query,
  loading,
  error,
  drawer,
  detailLoading,
  detail,
  devices,
  mutating,
  load,
  openDetail,
  toggleStatus,
  toggleRole,
  kick,
  revokeDevice,
} = useUserManagement();
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
            <el-button
              link
              :disabled="mutating || row.id === auth.user?.id"
              :type="row.status === 'active' ? 'danger' : 'success'"
              @click="toggleStatus(row)"
            >
              {{ row.status === "active" ? "禁用" : "启用" }}
            </el-button>
            <el-button v-if="row.id !== auth.user?.id" link type="warning" :disabled="mutating" @click="toggleRole(row)">
              {{ row.role === "admin" ? "取消管理员" : "设为管理员" }}
            </el-button>
            <el-button link type="info" :disabled="mutating" @click="kick(row)">踢下线</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <UserDetailDrawer
      v-model="drawer"
      :detail="detail"
      :devices="devices"
      :loading="detailLoading"
      :busy="mutating"
      @revoke="revokeDevice"
    />
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
</style>
