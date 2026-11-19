import { shallowRef, watch } from "vue";
import { useUserAccountStore } from "@/stores/user-account";
import { cloudError, cloudRequest, type CloudHost, type CloudRun, type CloudTask, type CloudTaskInput } from "@/lib/cloud-api";

export function useCloudTasks() {
  const account = useUserAccountStore();
  const tasks = shallowRef<CloudTask[]>([]);
  const runs = shallowRef<CloudRun[]>([]);
  const hosts = shallowRef<CloudHost[]>([]);
  const zone = shallowRef("");
  const loading = shallowRef(false);
  const saving = shallowRef(false);
  const error = shallowRef("");
  let revision = 0;
  async function refresh(): Promise<void> {
    const current = ++revision;
    if (!account.session) {
      loading.value = false;
      return;
    }
    loading.value = true;
    error.value = "";
    try {
      const [nextTasks, nextRuns, nextHosts, config] = await Promise.all([
        cloudRequest<CloudTask[]>("GET", "/api/automation/tasks"),
        cloudRequest<CloudRun[]>("GET", "/api/automation/tasks/runs?limit=50"),
        cloudRequest<CloudHost[]>("GET", "/api/hosts"),
        cloudRequest<{ zone: string }>("GET", "/api/automation/tasks/config"),
      ]);
      if (current === revision) {
        tasks.value = nextTasks;
        runs.value = nextRuns;
        hosts.value = nextHosts;
        zone.value = config.zone;
      }
    } catch (cause) {
      if (current === revision) error.value = cloudError(cause);
    } finally {
      if (current === revision) loading.value = false;
    }
  }
  watch(
    () => `${account.status?.baseUrl}/${account.session?.user.id}/${account.session?.device.id}`,
    () => {
      tasks.value = [];
      runs.value = [];
      hosts.value = [];
      zone.value = "";
      void refresh();
    },
    { immediate: true },
  );
  async function mutate(method: string, path: string, body?: unknown): Promise<boolean> {
    if (saving.value) return false;
    saving.value = true;
    error.value = "";
    try {
      await cloudRequest(method, path, body);
      await refresh();
      return true;
    } catch (cause) {
      error.value = cloudError(cause);
      return false;
    } finally {
      saving.value = false;
    }
  }
  async function save(id: string | null, input: CloudTaskInput): Promise<CloudTask | null> {
    if (saving.value) return null;
    saving.value = true;
    error.value = "";
    try {
      const task = await cloudRequest<CloudTask>(id ? "PUT" : "POST", `/api/automation/tasks${id ? "/" + id : ""}`, input);
      await refresh();
      return task;
    } catch (cause) {
      error.value = cloudError(cause);
      return null;
    } finally {
      saving.value = false;
    }
  }
  const remove = (id: string): Promise<boolean> => mutate("DELETE", `/api/automation/tasks/${id}`);
  const setEnabled = (task: CloudTask): Promise<boolean> =>
    mutate("POST", `/api/automation/tasks/${task.id}/${task.enabled ? "disable" : "enable"}`);
  return { tasks, runs, hosts, zone, loading, saving, error, refresh, save, remove, setEnabled };
}
