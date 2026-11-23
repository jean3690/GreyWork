<script setup lang="ts">
/** Java 模型来源接入表单；状态和请求统一交给 composable，不接触凭据。 */
import { onMounted, useId } from "vue";
import { useJavaModelGateway } from "./useJavaModelGateway";
import JavaGatewayKeyForm from "./JavaGatewayKeyForm.vue";
const { account, ready, providers, provider, model, models, loading, error, notice, refresh, fetchModels, useModel } =
  useJavaModelGateway();
const modelListId = useId();
onMounted(() => {
  void account.refresh();
});
</script>

<template>
  <section class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-4" data-testid="java-model-gateway">
    <div class="mb-2 flex items-center justify-between gap-2">
      <h2 class="text-[13px] font-medium text-foreground">Java 统一模型网关</h2>
      <button
        type="button"
        class="text-[11px] text-accent disabled:opacity-50"
        :disabled="!ready || loading"
        data-testid="java-gateway-refresh"
        @click="refresh"
      >
        刷新供应商
      </button>
    </div>
    <p class="mb-3 text-[11px] leading-relaxed text-dim2">
      {{ ready ? `当前账号服务器：${account.status?.baseUrl}` : "请先在账号页面登录 Java 服务器，再接入后端管理的模型。" }}
      本机直连配置仍保留；这里的账号 token 不会写入供应商设置。
    </p>
    <div v-if="ready" class="space-y-2.5">
      <p v-if="!providers.length && !loading" class="text-[11px] text-dim2">
        当前账号没有可用供应商。请先在 Java 后端保存供应商密钥，然后刷新。
      </p>
      <label class="flex items-center gap-2 text-[11.5px] text-dim2">
        <span class="w-20 shrink-0">后端供应商</span>
        <select
          v-model="provider"
          class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 text-foreground"
          :disabled="loading || !providers.length"
          data-testid="java-gateway-provider"
        >
          <option v-for="item in providers" :key="item.provider" :value="item.provider">
            {{ item.provider }} · {{ item.labels.join(" / ") }}
          </option>
        </select>
      </label>
      <label class="flex items-center gap-2 text-[11.5px] text-dim2">
        <span class="w-20 shrink-0">模型 ID</span>
        <input
          v-model="model"
          :list="modelListId"
          placeholder="可拉取或手动填写模型 ID"
          class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 font-mono text-foreground"
          data-testid="java-gateway-model"
        />
        <button
          type="button"
          class="shrink-0 text-accent disabled:opacity-50"
          :disabled="!provider || loading"
          data-testid="java-gateway-models"
          @click="fetchModels"
        >
          拉取模型
        </button>
      </label>
      <datalist :id="modelListId"><option v-for="id in models" :key="id" :value="id" /></datalist>
      <p class="text-[10.5px] text-dim2">
        仅支持 OpenAI 兼容 Chat Completions。模型发现不支持时可手填 ID；向量化、语音转写和外部 ACP CLI 继续使用各自配置。
      </p>
      <button
        type="button"
        class="rounded-[calc(8px*var(--gw-radius-scale))] bg-accent px-3 py-1.5 text-[11px] text-accent-ink disabled:opacity-50"
        :disabled="!provider || !model.trim() || loading"
        data-testid="java-gateway-use"
        @click="useModel"
      >
        选用此模型
      </button>
      <JavaGatewayKeyForm @created="refresh" />
    </div>
    <p v-if="error" class="mt-2 text-[11px] text-destructive" data-testid="java-gateway-error">{{ error }}</p>
    <p v-if="notice" class="mt-2 text-[11px] text-mint">{{ notice }}</p>
  </section>
</template>
