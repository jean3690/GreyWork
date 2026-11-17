<script setup lang="ts">
/** 供应商兼容性设置 + 无副作用的工具回填测试；不持有设置 store。 */
import { computed, onBeforeUnmount, shallowRef, useId, watch } from "vue";
import { hasHostCommands, invoke } from "@greywork/host-ipc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { parseModelExtraBody, validateModelConnection } from "@/lib/model-provider-config";

const props = defineProps<{
  connection: {
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    headers?: Record<string, string>;
    temperature?: number;
    maxTokens?: number;
    reasoningEffort?: string;
  };
  connectionError?: string | null;
}>();
const stream = defineModel<boolean>("stream", { required: true });
const extraBodyText = defineModel<string>("extraBodyText", { required: true });
const emit = defineEmits<{ change: [] }>();
const inputId = useId();
const parsed = computed(() => parseModelExtraBody(extraBodyText.value));
const busy = shallowRef(false);
const result = shallowRef<string | null>(null);
let revision = 0;
watch(
  () => [props.connection, props.connectionError, stream.value, extraBodyText.value],
  () => {
    revision += 1;
    result.value = null;
  },
  { deep: true },
);
onBeforeUnmount(() => {
  revision += 1;
});

async function probe(): Promise<void> {
  const error = props.connectionError || validateModelConnection(props.connection.baseUrl, props.connection.model) || parsed.value.error;
  if (error) {
    result.value = error;
    return;
  }
  const current = revision;
  busy.value = true;
  result.value = null;
  try {
    await invoke("llm_agent_probe", { ...props.connection, stream: stream.value, extraBody: parsed.value.value });
    if (current === revision) result.value = "工具调用及结果回填测试通过，可开启 Agent 模式。";
  } catch (error) {
    if (current === revision) result.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <fieldset class="flex min-w-0 flex-col gap-2.5">
    <legend class="mb-2 text-[11.5px] text-dim2">第三方模型兼容性</legend>
    <label class="flex items-center gap-2 text-[11.5px] text-foreground">
      <input
        v-model="stream"
        type="checkbox"
        data-testid="provider-stream"
        class="size-4 accent-[var(--accent)]"
        @change="emit('change')"
      />
      流式输出（不支持 SSE 的网关可关闭）
    </label>
    <label :for="inputId" class="text-[11.5px] text-dim2">自定义请求参数（JSON）</label>
    <Textarea
      :id="inputId"
      v-model="extraBodyText"
      :rows="4"
      :aria-invalid="!!parsed.error"
      data-testid="provider-extra-body"
      spellcheck="false"
      placeholder='{"max_completion_tokens": 8192, "enable_thinking": true}'
      @update:model-value="emit('change')"
    />
    <p class="text-[10.5px] leading-relaxed text-dim2">
      可设置 top_p、enable_thinking、chat_template_kwargs 等网关参数；null 可移除不支持的采样参数。 不允许覆盖
      model、messages、tools、tool_choice、stream 等控制字段。不要在这里填写密钥。
    </p>
    <p v-if="parsed.error" role="alert" class="text-[11px] text-destructive">{{ parsed.error }}</p>
    <div class="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        :disabled="busy || !hasHostCommands()"
        data-testid="provider-tool-probe"
        @click="probe"
      >
        {{ busy ? "测试中…" : "测试工具调用" }}
      </Button>
      <span class="text-[10.5px] text-dim2">会发送两次模型请求；不读写工作区、不执行命令。</span>
    </div>
    <p v-if="result" role="status" data-testid="provider-tool-probe-result" class="text-[11px] text-foreground">{{ result }}</p>
  </fieldset>
</template>
