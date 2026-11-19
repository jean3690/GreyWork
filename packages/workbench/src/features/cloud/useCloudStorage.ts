import { computed, shallowRef, watch } from "vue";
import { useUserAccountStore } from "@/stores/user-account";
import { cloudError, cloudRequest, type CloudCollection, type CloudObject, type CloudStorageConfig } from "@/lib/cloud-api";

export function useCloudStorage(kind: CloudCollection) {
  const account = useUserAccountStore();
  const objects = shallowRef<CloudObject[]>([]);
  const config = shallowRef<CloudStorageConfig | null>(null);
  const loading = shallowRef(false);
  const error = shallowRef("");
  const query = shallowRef("");
  const visible = computed(() => objects.value.filter((object) => object.name.toLowerCase().includes(query.value.toLowerCase())));
  let revision = 0;
  async function refresh(): Promise<void> {
    const current = ++revision;
    if (!account.session) {
      objects.value = [];
      config.value = null;
      loading.value = false;
      return;
    }
    loading.value = true;
    error.value = "";
    try {
      const [nextConfig, rows] = await Promise.all([
        cloudRequest<CloudStorageConfig>("GET", "/api/storage/config"),
        cloudRequest<CloudObject[]>("GET", `/api/storage/objects?kind=${kind}&limit=200`),
      ]);
      if (current === revision) {
        config.value = nextConfig;
        objects.value = rows;
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
      objects.value = [];
      config.value = null;
      void refresh();
    },
    { immediate: true },
  );
  async function remove(id: string): Promise<void> {
    try {
      await cloudRequest("DELETE", `/api/storage/objects/${id}`);
      await refresh();
    } catch (cause) {
      error.value = cloudError(cause);
    }
  }
  return { objects, config, visible, loading, error, query, refresh, remove };
}
