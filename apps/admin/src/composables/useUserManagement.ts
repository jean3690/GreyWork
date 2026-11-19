import { onMounted, shallowRef, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { adminApi } from "../api";
import { ApiError } from "../api/http";
import type { DeviceItem, UserDetail, UserItem } from "../types";

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** 请求序号阻止旧搜索/详情回写；确认期间也锁住写操作，避免重复提交。 */
export function useUserManagement() {
  const rows = shallowRef<UserItem[]>([]);
  const query = shallowRef("");
  const loading = shallowRef(false);
  const error = shallowRef("");
  const drawer = shallowRef(false);
  const detailLoading = shallowRef(false);
  const detail = shallowRef<UserDetail | null>(null);
  const devices = shallowRef<DeviceItem[]>([]);
  const currentId = shallowRef<string | null>(null);
  const mutating = shallowRef(false);
  let listRevision = 0;
  let detailRevision = 0;

  async function load(): Promise<void> {
    const revision = ++listRevision;
    loading.value = true;
    error.value = "";
    try {
      const next = await adminApi.users(query.value.trim() || undefined, 100);
      if (revision === listRevision) rows.value = next;
    } catch (cause) {
      if (revision === listRevision) error.value = messageOf(cause, "用户列表加载失败");
    } finally {
      if (revision === listRevision) loading.value = false;
    }
  }

  async function loadDetail(id: string): Promise<void> {
    const revision = ++detailRevision;
    detailLoading.value = true;
    try {
      const [info, list] = await Promise.all([adminApi.userDetail(id), adminApi.userDevices(id)]);
      if (revision !== detailRevision || currentId.value !== id || !drawer.value) return;
      detail.value = info;
      devices.value = list;
    } catch (cause) {
      if (revision === detailRevision && drawer.value) ElMessage.error(messageOf(cause, "用户详情加载失败"));
    } finally {
      if (revision === detailRevision) detailLoading.value = false;
    }
  }

  async function openDetail(row: UserItem): Promise<void> {
    currentId.value = row.id;
    detail.value = null;
    devices.value = [];
    drawer.value = true;
    await loadDetail(row.id);
  }

  watch(drawer, (open) => {
    if (open) return;
    detailRevision += 1;
    currentId.value = null;
    detail.value = null;
    devices.value = [];
    detailLoading.value = false;
  });

  async function reloadUser(id: string): Promise<void> {
    await load();
    if (currentId.value === id && drawer.value) await loadDetail(id);
  }

  async function confirmAction(message: string, title: string, label: string, action: () => Promise<void>): Promise<void> {
    if (mutating.value) return;
    mutating.value = true;
    try {
      try {
        await ElMessageBox.confirm(message, title, { confirmButtonText: label, cancelButtonText: "取消", type: "warning" });
      } catch {
        return;
      }
      await action();
    } catch (cause) {
      ElMessage.error(messageOf(cause, "操作失败"));
    } finally {
      mutating.value = false;
    }
  }

  async function toggleStatus(row: UserItem): Promise<void> {
    const next = row.status === "active" ? "disabled" : "active";
    await confirmAction(
      next === "disabled" ? "禁用后该用户立即无法登录，且现有会话会被全部吊销。" : "启用后该用户可以重新登录。",
      (next === "disabled" ? "禁用 " : "启用 ") + row.email,
      "确认",
      async () => {
        await adminApi.updateUser(row.id, { status: next });
        ElMessage.success(next === "disabled" ? "已禁用" : "已启用");
        await reloadUser(row.id);
      },
    );
  }

  async function toggleRole(row: UserItem): Promise<void> {
    const next = row.role === "admin" ? "user" : "admin";
    await confirmAction(
      next === "admin" ? "提为管理员后，该账号可以访问整个运维台。" : "降为普通用户后，该账号将无法进入运维台。",
      (next === "admin" ? "设为管理员：" : "取消管理员：") + row.email,
      "确认",
      async () => {
        await adminApi.updateUser(row.id, { role: next });
        ElMessage.success(next === "admin" ? "已设为管理员" : "已降为普通用户");
        await reloadUser(row.id);
      },
    );
  }

  async function kick(row: UserItem): Promise<void> {
    await confirmAction("只清理登录会话，账号仍然可用（用户下次登录即可）。", "踢下线：" + row.email, "踢下线", async () => {
      const result = await adminApi.revokeSessions(row.id);
      ElMessage.success("已清理 " + result.devices + " 台设备的会话");
      await reloadUser(row.id);
    });
  }

  async function revokeDevice(device: DeviceItem): Promise<void> {
    // 弹窗期间可能切换抽屉，必须捕获设备所属用户而不是确认后读取 currentId。
    const userId = currentId.value;
    if (!userId) return;
    await confirmAction("吊销后这台设备需要重新登录。", "吊销设备：" + device.name, "吊销", async () => {
      await adminApi.revokeDevice(userId, device.id);
      ElMessage.success("设备已吊销");
      await reloadUser(userId);
    });
  }

  onMounted(() => {
    void load();
  });
  return {
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
  };
}
