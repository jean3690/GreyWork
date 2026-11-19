import { computed, shallowRef } from "vue";
import { defineStore } from "pinia";
import { hasHostCommands, invoke } from "@greywork/host-ipc";
import type {
  AccountLoginInput,
  ControlPlaneAccount,
  ControlPlaneDevice,
  ControlPlaneSession,
  ControlPlaneStatus,
} from "@/lib/control-plane";

/** 侧栏、用户页与控制面设置共用的身份。刷新结果不能覆盖后发生的登录/退出。 */
export const useUserAccountStore = defineStore("user-account", () => {
  const available = hasHostCommands();
  const status = shallowRef<ControlPlaneStatus | null>(null);
  const session = shallowRef<ControlPlaneSession | null>(null);
  const devices = shallowRef<ControlPlaneDevice[]>([]);
  const devicesLoaded = shallowRef(false);
  const error = shallowRef("");
  const refreshing = shallowRef(false);
  const mutating = shallowRef(false);
  const busy = computed(() => refreshing.value || mutating.value);
  const envManaged = computed(() => status.value?.source === "env");
  let revision = 0;
  let pending: Promise<void> | null = null;

  function acceptStatus(next: ControlPlaneStatus): void {
    revision += 1;
    // 连接配置被改变时不能继续展示旧用户。
    session.value = null;
    devices.value = [];
    devicesLoaded.value = false;
    status.value = next;
    error.value = "";
  }

  function apply(next: ControlPlaneAccount): void {
    if (!next.session || next.session.user.id !== session.value?.user.id || next.status.baseUrl !== status.value?.baseUrl) {
      devices.value = [];
      devicesLoaded.value = false;
    }
    status.value = next.status;
    session.value = next.session;
    error.value = next.error ?? "";
    if (next.session && next.devices) {
      devices.value = next.devices;
      devicesLoaded.value = true;
    }
  }

  async function refresh(): Promise<void> {
    if (!available || mutating.value) return;
    if (pending) return pending;
    const current = revision;
    refreshing.value = true;
    pending = (async () => {
      try {
        const next = await invoke<ControlPlaneAccount>("control_plane_account");
        if (current === revision) apply(next);
      } catch (cause) {
        if (current === revision) {
          session.value = null;
          devices.value = [];
          devicesLoaded.value = false;
          error.value = cause instanceof Error ? cause.message : String(cause);
        }
      } finally {
        refreshing.value = false;
        pending = null;
      }
    })();
    return pending;
  }

  async function login(input: AccountLoginInput): Promise<boolean> {
    if (!available || mutating.value || envManaged.value) return false;
    const current = ++revision;
    mutating.value = true;
    error.value = "";
    try {
      const next = await invoke<ControlPlaneStatus>("control_plane_connect", { ...input });
      if (current !== revision) return false;
      acceptStatus(next);
      const linkedRevision = revision;
      const identity = await invoke<ControlPlaneAccount>("control_plane_account");
      if (linkedRevision !== revision) return false;
      apply(identity);
      return session.value !== null;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally {
      mutating.value = false;
    }
  }

  async function logout(): Promise<boolean> {
    if (!available || mutating.value || envManaged.value) return false;
    const current = ++revision;
    mutating.value = true;
    error.value = "";
    try {
      const next = await invoke<ControlPlaneStatus>("control_plane_logout");
      if (current !== revision) return false;
      acceptStatus(next);
      return true;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally {
      mutating.value = false;
    }
  }

  async function manage(command: string, args?: Record<string, string>): Promise<boolean> {
    if (!available || mutating.value || !session.value || (command !== "control_plane_devices" && envManaged.value)) return false;
    const current = ++revision;
    mutating.value = true;
    error.value = "";
    try {
      const next = args ? await invoke<ControlPlaneAccount>(command, args) : await invoke<ControlPlaneAccount>(command);
      if (current !== revision) return false;
      apply(next);
      return next.error === null && next.session !== null;
    } catch (cause) {
      if (current === revision) error.value = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally {
      mutating.value = false;
    }
  }

  const loadDevices = (): Promise<boolean> => manage("control_plane_devices");
  const saveProfile = (displayName: string): Promise<boolean> =>
    manage("control_plane_profile_update", { displayName: displayName.trim() });
  const revokeOtherSessions = (): Promise<boolean> => manage("control_plane_sessions_revoke");
  function revokeDevice(deviceId: string): Promise<boolean> {
    if (deviceId === String(session.value?.device.id)) return Promise.resolve(false);
    return manage("control_plane_device_revoke", { deviceId });
  }

  return {
    available,
    status,
    session,
    devices,
    devicesLoaded,
    error,
    busy,
    envManaged,
    refresh,
    login,
    logout,
    acceptStatus,
    loadDevices,
    saveProfile,
    revokeDevice,
    revokeOtherSessions,
  };
});
