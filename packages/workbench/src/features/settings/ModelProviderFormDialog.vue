<script setup lang="ts">
/**
 * 模型供应商新增弹窗（受控，仅新增）。
 *
 * 收集字段后 emit `save(payload)`，父级补 id/kind/enabled 再落库并选中。
 * API key 只填**环境变量名**（值由宿主从启动进程的环境里读），不落明文。
 */
import { ref, watch } from "vue";
import CloseIcon from "@/features/shared/Icon.vue";
import { parseHeaderText } from "@/stores/agent/shared";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export interface ModelProviderDraftPayload {
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  headers?: Record<string, string>;
}

const props = defineProps<{
  open: boolean;
  /** 已有供应商名；同名会让人分不清列表里两行，保存前就地拒绝。 */
  existingNames?: string[];
}>();

const emit = defineEmits<{ save: [payload: ModelProviderDraftPayload]; cancel: [] }>();

const draft = ref({ name: "", baseUrl: "", model: "", apiKeyEnv: "CUSTOM_LLM_API_KEY", headersText: "" });
const error = ref<string | null>(null);

function resetDraft(): void {
  draft.value = { name: "", baseUrl: "", model: "", apiKeyEnv: "CUSTOM_LLM_API_KEY", headersText: "" };
  error.value = null;
}

watch(
  () => props.open,
  (open) => {
    if (open) resetDraft();
  },
);

function save(): void {
  const trimmedName = draft.value.name.trim();
  if (!trimmedName) {
    error.value = "请填写供应商名称";
    return;
  }
  if ((props.existingNames ?? []).some((candidate) => candidate.trim().toLocaleLowerCase() === trimmedName.toLocaleLowerCase())) {
    error.value = `名称「${trimmedName}」已存在`;
    return;
  }
  // 请求头在保存前解析：非法行就地报错，不写进库（宿主发请求时还会解析一次占位符）。
  const parsed = parseHeaderText(draft.value.headersText);
  if (parsed.error) {
    error.value = parsed.error;
    return;
  }
  error.value = null;
  emit("save", {
    name: trimmedName,
    baseUrl: draft.value.baseUrl.trim(),
    model: draft.value.model.trim(),
    apiKeyEnv: draft.value.apiKeyEnv.trim(),
    headers: Object.keys(parsed.headers).length > 0 ? parsed.headers : undefined,
  });
}

/** Dialog 收下 Esc / 点遮罩后关闭；open 归 false 即通知父级收起（受控：prop 是真源）。 */
function onOpenChange(next: boolean): void {
  if (!next) emit("cancel");
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      :show-close-button="false"
      class="flex max-h-[90vh] flex-col gap-0 overflow-hidden rounded-[14px] border-line bg-panel p-0 shadow-xl sm:max-w-[460px]"
    >
      <div class="flex items-center justify-between px-4 pb-2 pt-3.5">
        <DialogTitle class="text-[13px] font-medium text-foreground">新增供应商</DialogTitle>
        <button
          type="button"
          class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
          aria-label="关闭"
          @click="emit('cancel')"
        >
          <CloseIcon name="close" :size="13" />
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 pb-4 pt-1">
        <DialogDescription class="text-[11px] leading-relaxed text-dim2">
          新建一台 OpenAI 兼容的模型供应商。建好后在下方列表里选中它，即可继续改推理等级等配置。
        </DialogDescription>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-dim2">名称</span>
          <input
            v-model="draft.name"
            data-testid="provider-name"
            class="w-full rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            placeholder="如 My Gateway"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-dim2">Base URL</span>
          <input
            v-model="draft.baseUrl"
            data-testid="provider-base-url"
            class="w-full rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            placeholder="https://api.openai.com/v1"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-dim2">模型</span>
          <input
            v-model="draft.model"
            data-testid="provider-model"
            class="w-full rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            placeholder="gpt-4o / claude-sonnet-4-5"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-dim2">API Key 环境变量</span>
          <input
            v-model="draft.apiKeyEnv"
            data-testid="provider-api-key-env"
            class="w-full rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            placeholder="OPENAI_API_KEY"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-dim2">自定义 Headers</span>
          <textarea
            v-model="draft.headersText"
            data-testid="provider-headers"
            rows="3"
            spellcheck="false"
            class="w-full resize-y rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[11.5px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            placeholder="每行一条 Key: Value"
          />
        </label>
        <p class="text-[10.5px] leading-relaxed text-dim2">
          Key 在桌面端从启动应用的 shell 环境变量读取：先
          <code class="font-mono">export {{ draft.apiKeyEnv || "OPENAI_API_KEY" }}=…</code>
          再从同一终端启动 GreyWork。请求头里的敏感值写
          <code v-pre class="font-mono">{{ ENV_VAR }}</code> 占位符，发送时由宿主解析，绝不明文落盘。
        </p>
        <p v-if="error" class="text-[11px] text-destructive">{{ error }}</p>
      </div>

      <div class="flex justify-end gap-2 border-t border-line px-4 py-3">
        <button
          type="button"
          class="rounded-[8px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground"
          @click="emit('cancel')"
        >
          取消
        </button>
        <button
          data-testid="provider-save"
          type="button"
          class="rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink"
          @click="save"
        >
          添加
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>
