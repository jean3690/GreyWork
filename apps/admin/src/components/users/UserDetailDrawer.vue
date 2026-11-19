<script setup lang="ts">
import type { DeviceItem, UserDetail } from "../../types";
import { formatDateTime, platformLabel } from "../../utils/format";

const open = defineModel<boolean>({ required: true });
defineProps<{ detail: UserDetail | null; devices: DeviceItem[]; loading: boolean; busy: boolean }>();
const emit = defineEmits<{ revoke: [device: DeviceItem] }>();
</script>

<template>
  <el-drawer v-model="open" size="560px" :title="detail?.email || '用户详情'">
    <div v-loading="loading" class="drawer-body">
      <template v-if="detail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="昵称">{{ detail.displayName || "—" }}</el-descriptions-item>
          <el-descriptions-item label="角色">{{ detail.role === "admin" ? "管理员" : "普通用户" }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="detail.status === 'active' ? 'success' : 'danger'" size="small" effect="plain">{{
              detail.status === "active" ? "正常" : "已禁用"
            }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="注册来源">{{
            detail.providers.length ? detail.providers.join(" / ") : "入场码"
          }}</el-descriptions-item>
          <el-descriptions-item label="设备数">{{ detail.deviceCount }}</el-descriptions-item>
          <el-descriptions-item label="最近活跃">{{ formatDateTime(detail.lastActiveAt) }}</el-descriptions-item>
          <el-descriptions-item label="注册时间" :span="2">{{ formatDateTime(detail.createdAt) }}</el-descriptions-item>
        </el-descriptions>

        <h4 class="devices-title">设备</h4>
        <el-table :data="devices" size="small" empty-text="该账号还没有设备">
          <el-table-column prop="name" label="名称" min-width="110" />
          <el-table-column label="平台" width="90">
            <template #default="{ row }">{{ platformLabel(row.platform) }}</template>
          </el-table-column>
          <el-table-column label="最后活跃" width="150">
            <template #default="{ row }"
              ><span class="gw-dim">{{ formatDateTime(row.lastSeenAt) }}</span></template
            >
          </el-table-column>
          <el-table-column label="操作" width="80" fixed="right">
            <template #default="{ row }"
              ><el-button link type="danger" :disabled="busy" @click="emit('revoke', row)">吊销</el-button></template
            >
          </el-table-column>
        </el-table>
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
.drawer-body {
  min-height: 120px;
}
.devices-title {
  margin: 22px 0 10px;
  font-size: 12.5px;
  color: var(--gw-dim);
  font-weight: 600;
}
</style>
