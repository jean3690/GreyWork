<script setup lang="ts">
/**
 * ACP 后端新增/编辑弹窗（受控）。
 *
 * - `entry` 非空 = 编辑既有自配后端（名称 / 命令 / 图标 / 环境变量）；
 * - 收集字段后 emit `save(payload)`，父级按有无 entry 决定 add / update 落库；
 * - 编辑态额外给一个删除入口（仅 custom-* 项可达，预设项不给编辑按钮）。
 */
import { computed, ref, watch } from "vue";
import type { AgentProviderConfig } from "@greywork/shell";
import CloseIcon from "@/features/shared/Icon.vue";
import IconPicker from "@/features/shared/IconPicker.vue";
import { formatEnvText, parseEnvText } from "@/stores/agent/shared";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export interface AgentProviderDraftPayload {
  name: string;
  command: string;
  icon?: string;
  env?: Record<string, string>;
}

const props = defineProps<{
  open: boolean;
  entry: AgentProviderConfig | null;
  /** 父级落库失败时的错误（如后端拒绝该启动命令），与本地解析错误同一处展示。 */
  error?: string | null;
}>();

const emit = defineEmits<{ save: [payload: AgentProviderDraftPayload]; remove: []; cancel: [] }>();

const draft = ref({ name: "", command: "", icon: "", envText: "" });
const localError = ref<string | null>(null);

function resetDraft(): void {
  localError.value = null;
  draft.value = props.entry
    ? {
        name: props.entry.name,
        command: props.entry.command,
        icon: props.entry.icon ?? "",
        envText: formatEnvText(props.entry.env),
      }
    : { name: "", command: "", icon: "", envText: "" };
}

watch(
  () => props.open,
  (open) => {
    if (open) resetDraft();
  },
);

const title = computed(() => (props.entry ? "编辑 ACP 后端" : "新增 ACP 后端"));
const shownError = computed(() => props.error ?? localError.value);

function save(): void {
  // 环境变量在保存前解析：非法行就地报错，不写进库（宿主侧还会再校验一次）。
  const parsed = parseEnvText(draft.value.envText);
  if (parsed.error) {
    localError.value = parsed.error;
    return;
  }
  localError.value = null;
  emit("save", {
    name: draft.value.name,
    command: draft.value.command,
    icon: draft.value.icon || undefined,
    env: Object.keys(parsed.env).length > 0 ? parsed.env : undefined,
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
        <DialogTitle class="text-[13px] font-medium text-foreground">{{ title }}</DialogTitle>
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
          自配后端可填任意 ACP 启动命令（如 <code class="font-mono">my-agent acp</code>），仅限本机已安装的程序，含 shell
          元字符的命令会被宿主拒绝。
        </DialogDescription>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-dim2">名称</span>
          <input
            v-model="draft.name"
            data-testid="agent-provider-name"
            class="w-full rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            placeholder="如 My Agent"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-dim2">启动命令</span>
          <input
            v-model="draft.command"
            data-testid="agent-provider-command"
            class="w-full rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            placeholder="如 my-agent acp / npx -y @scope/pkg-acp"
          />
        </label>
        <div class="flex flex-col gap-1">
          <span class="text-[11px] text-dim2">图标</span>
          <IconPicker v-model="draft.icon" :columns="12" clearable clear-label="默认" />
        </div>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-dim2">环境变量</span>
          <textarea
            v-model="draft.envText"
            data-testid="agent-provider-env"
            rows="3"
            spellcheck="false"
            class="w-full resize-y rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[11.5px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            placeholder="每行一条 KEY=VALUE，如 ANTHROPIC_API_KEY=sk-…"
          />
        </label>
        <p class="text-[10.5px] leading-relaxed text-dim2">
          环境变量随启动注入该后端进程（沙盒开启时同样生效）；不填即继承宿主环境。空行与
          <code class="font-mono">#</code> 开头的行忽略。
        </p>
        <p v-if="shownError" class="text-[11px] text-destructive">{{ shownError }}</p>
      </div>

      <div class="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
        <button
          v-if="entry"
          data-testid="agent-provider-remove"
          type="button"
          class="rounded-[8px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:border-line-2 hover:text-destructive"
          @click="emit('remove')"
        >
          删除
        </button>
        <div class="ml-auto flex gap-2">
          <button
            type="button"
            class="rounded-[8px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground"
            @click="emit('cancel')"
          >
            取消
          </button>
          <button
            data-testid="agent-provider-save"
            type="button"
            class="rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink"
            @click="save"
          >
            {{ entry ? "保存" : "添加" }}
          </button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
