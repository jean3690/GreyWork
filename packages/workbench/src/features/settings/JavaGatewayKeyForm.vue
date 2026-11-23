<script setup lang="ts">
/** 密钥只作一次写入；不进入设置 store / localStorage，Java 负责加密保存。 */
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { cloudRequest } from "@/lib/cloud-api";
import { JAVA_GATEWAY_PROVIDERS } from "@/lib/java-model-gateway";
import { validateModelConnection } from "@/lib/model-provider-config";
import { useUserAccountStore } from "@/stores/user-account";
const emit = defineEmits<{ created: [] }>();
const account = useUserAccountStore();
const draft = ref({ provider: "openai", label: "default", baseUrl: "", apiKey: "" });
const busy = shallowRef(false);
const error = shallowRef("");
const notice = shallowRef("");
const canSave = computed(() => !!account.session && !busy.value && !!draft.value.apiKey.trim());
let revision = 0;
onScopeDispose(() => {
  revision += 1;
  draft.value.apiKey = "";
});
watch([() => account.status?.baseUrl, () => account.session?.user.id, () => account.session?.device.id], () => {
  revision += 1;
  draft.value.apiKey = "";
  error.value = "";
  notice.value = "";
});
async function save(): Promise<void> {
  if (!canSave.value) return;
  if (draft.value.baseUrl.trim()) {
    const invalid = validateModelConnection(draft.value.baseUrl, "placeholder");
    if (invalid || !/^https?:\/\//.test(draft.value.baseUrl.trim())) {
      error.value = invalid || "请填写 HTTP(S) 上游地址";
      return;
    }
  }
  const current = revision;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await cloudRequest("POST", "/api/llm/keys", {
      provider: draft.value.provider,
      label: draft.value.label.trim() || "default",
      baseUrl: draft.value.baseUrl.trim() || undefined,
      apiKey: draft.value.apiKey.trim(),
    });
    if (current !== revision) return;
    draft.value.apiKey = "";
    notice.value = "密钥已保存到 Java 后端；该账号的其他设备无需重复填写。";
    emit("created");
  } catch (cause) {
    if (current === revision) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <details class="border-t border-line pt-2 text-[11px] text-dim2">
    <summary class="cursor-pointer text-accent">向 Java 后端添加供应商密钥</summary>
    <form class="mt-2 space-y-2" data-testid="java-gateway-key-form" @submit.prevent="save">
      <p>写入当前账号的 Java 密钥库，不保存到客户端设置。后端需要配置 GREY_MASTER_KEY；Anthropic/custom 需提供 OpenAI 兼容上游地址。</p>
      <label class="flex items-center gap-2"
        ><span class="w-20 shrink-0">供应商</span>
        <select
          v-model="draft.provider"
          class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 text-foreground"
          :disabled="busy"
          data-testid="java-key-provider"
        >
          <option v-for="name in JAVA_GATEWAY_PROVIDERS" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label class="flex items-center gap-2"
        ><span class="w-20 shrink-0">标签</span
        ><input
          v-model="draft.label"
          :disabled="busy"
          maxlength="64"
          class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 text-foreground"
      /></label>
      <label class="flex items-center gap-2"
        ><span class="w-20 shrink-0">上游 Base URL</span
        ><input
          v-model="draft.baseUrl"
          :disabled="busy"
          placeholder="留空使用该供应商默认地址"
          class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 text-foreground"
      /></label>
      <label class="flex items-center gap-2"
        ><span class="w-20 shrink-0">API Key</span
        ><input
          v-model="draft.apiKey"
          type="password"
          autocomplete="off"
          :disabled="busy"
          class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 text-foreground"
          data-testid="java-key-secret"
      /></label>
      <button
        type="submit"
        class="rounded-[calc(8px*var(--gw-radius-scale))] bg-accent px-3 py-1.5 text-accent-ink disabled:opacity-50"
        :disabled="!canSave"
        data-testid="java-key-save"
      >
        {{ busy ? "保存中…" : "保存到 Java 后端" }}
      </button>
      <p v-if="error" class="text-destructive">{{ error }}</p>
      <p v-if="notice" class="text-mint">{{ notice }}</p>
    </form>
  </details>
</template>
