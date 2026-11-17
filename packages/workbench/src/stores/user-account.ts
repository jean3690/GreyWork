import { computed, shallowRef } from "vue";
import { defineStore } from "pinia";
import { hasHostCommands, invoke } from "@greywork/host-ipc";
import type { AccountLoginInput, ControlPlaneAccount, ControlPlaneSession, ControlPlaneStatus } from "@/lib/control-plane";

/** 侧栏、用户页与控制面设置共用的身份。刷新结果不能覆盖后发生的登录/退出。 */
export const useUserAccountStore = defineStore("user-account", () => {
  const available = hasHostCommands();
  const status = shallowRef<ControlPlaneStatus | null>(null);
  const session = shallowRef<ControlPlaneSession | null>(null);
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
    status.value = next;
    error.value = "";
  }

  function apply(next: ControlPlaneAccount): void {
    status.value = next.status;
    session.value = next.session;
    error.value = next.error ?? "";
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
    revision += 1;
    mutating.value = true;
    error.value = "";
    try {
      const next = await invoke<ControlPlaneStatus>("control_plane_connect", { ...input });
      acceptStatus(next);
      apply(await invoke<ControlPlaneAccount>("control_plane_account"));
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
    revision += 1;
    mutating.value = true;
    error.value = "";
    try {
      acceptStatus(await invoke<ControlPlaneStatus>("control_plane_logout"));
      return true;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally {
      mutating.value = false;
    }
  }

  return { available, status, session, error, busy, envManaged, refresh, login, logout, acceptStatus };
});
