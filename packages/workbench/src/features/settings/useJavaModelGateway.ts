import { computed, onScopeDispose, shallowRef, watch } from "vue";
import { createLlmClient } from "@greywork/llm";
import { cloudRequest } from "@/lib/cloud-api";
import { JAVA_GATEWAY_PREFIX, JAVA_GATEWAY_PROVIDERS } from "@/lib/java-model-gateway";
import { useSettingsStore } from "@/stores/settings";
import { useUserAccountStore } from "@/stores/user-account";

interface GatewayProvider {
  provider: string;
  labels: string[];
}
export function useJavaModelGateway() {
  const account = useUserAccountStore();
  const settings = useSettingsStore();
  const llm = createLlmClient();
  const providers = shallowRef<GatewayProvider[]>([]);
  const provider = shallowRef("");
  const model = shallowRef("");
  const models = shallowRef<string[]>([]);
  const loading = shallowRef(false);
  const error = shallowRef("");
  const notice = shallowRef("");
  const ready = computed(() => account.available && !!account.session);
  let revision = 0;
  onScopeDispose(() => {
    revision += 1;
  });

  async function refresh(): Promise<void> {
    if (!ready.value) return;
    const current = ++revision;
    loading.value = true;
    error.value = "";
    try {
      const rows = await cloudRequest<GatewayProvider[]>("GET", "/api/llm/providers");
      if (current !== revision) return;
      providers.value = rows
        .filter((item) => JAVA_GATEWAY_PROVIDERS.some((name) => name === item.provider))
        .map((item) => ({
          provider: item.provider,
          labels: Array.isArray(item.labels) ? item.labels.filter((label) => typeof label === "string") : [],
        }));
      if (!providers.value.some((item) => item.provider === provider.value)) provider.value = providers.value[0]?.provider ?? "";
    } catch (cause) {
      if (current === revision) {
        providers.value = [];
        error.value = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      if (current === revision) loading.value = false;
    }
  }

  async function fetchModels(): Promise<void> {
    if (!ready.value || !provider.value) return;
    const current = ++revision;
    loading.value = true;
    error.value = "";
    try {
      const ids = await llm.listModels({ baseUrl: JAVA_GATEWAY_PREFIX + provider.value });
      if (current === revision) {
        models.value = ids;
        if (!model.value) model.value = ids[0] ?? "";
      }
    } catch (cause) {
      if (current === revision) {
        models.value = [];
        error.value = `${cause instanceof Error ? cause.message : String(cause)}（也可手动填写模型 ID）`;
      }
    } finally {
      if (current === revision) loading.value = false;
    }
  }

  function useModel(): void {
    if (!ready.value || !providers.value.some((item) => item.provider === provider.value) || !model.value.trim()) return;
    const id = `java-${provider.value}`;
    const previous = settings.modelProviders.find((item) => item.id === id);
    settings.upsertModelProvider({
      ...previous,
      id,
      name: previous?.name ?? `Java 网关 · ${provider.value}`,
      kind: "openai-compatible",
      baseUrl: JAVA_GATEWAY_PREFIX + provider.value,
      model: model.value.trim(),
      enabled: true,
      apiKeyEnv: undefined,
      headers: undefined,
      agentMode: previous?.model === model.value.trim() ? previous.agentMode === true : false,
    });
    settings.selectModelProvider(id);
    notice.value = "已选用 Java 模型网关；供应商密钥保存在 Java 后端，账号凭据由宿主注入。可测试工具调用后开启 Agent 模式。";
  }

  watch(provider, () => {
    revision += 1;
    models.value = [];
    model.value = "";
    error.value = "";
    loading.value = false;
  });
  watch(
    [() => account.status?.baseUrl, () => account.session?.user.id],
    () => {
      revision += 1;
      providers.value = [];
      provider.value = "";
      models.value = [];
      model.value = "";
      error.value = "";
      notice.value = "";
      loading.value = false;
      if (ready.value) void refresh();
    },
    { immediate: true },
  );
  return { account, ready, providers, provider, model, models, loading, error, notice, refresh, fetchModels, useModel };
}
