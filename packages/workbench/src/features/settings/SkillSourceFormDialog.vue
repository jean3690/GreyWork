<script setup lang="ts">
/**
 * 自定义技能市场源新增/编辑弹窗（受控）。
 *
 * 两种源类型：
 * - api：兼容 skills.sh 协议的 HTTP 端点（提供 /api/search 和 /api/download）；
 * - github：按 GitHub 仓库名过滤（仓库须已被 skills.sh 索引才能搜到）。
 */
import { computed, ref, watch } from "vue";
import type { SkillSourceEntry } from "@/stores/settings";
import CloseIcon from "@/features/shared/Icon.vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

interface Draft {
  label: string;
  type: SkillSourceEntry["type"];
  url: string;
  repo: string;
}

const props = defineProps<{
  open: boolean;
  entry: SkillSourceEntry | null;
  existingLabels?: string[];
}>();

const emit = defineEmits<{ save: [payload: SkillSourceEntry]; cancel: [] }>();

const draft = ref<Draft>({ label: "", type: "api", url: "", repo: "" });
const error = ref<string | null>(null);

function resetDraft(): void {
  error.value = null;
  if (props.entry) {
    draft.value = {
      label: props.entry.label,
      type: props.entry.type,
      url: props.entry.url ?? "",
      repo: props.entry.repo ?? "",
    };
  } else {
    draft.value = { label: "", type: "api", url: "", repo: "" };
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) resetDraft();
  },
);

const title = computed(() => (props.entry ? "编辑技能源" : "添加技能源"));

function save(): void {
  const trimmedLabel = draft.value.label.trim();
  if (!trimmedLabel) {
    error.value = "请填写源名称";
    return;
  }
  if ((props.existingLabels ?? []).some((candidate) => candidate.trim().toLocaleLowerCase() === trimmedLabel.toLocaleLowerCase())) {
    error.value = `名称「${trimmedLabel}」已存在`;
    return;
  }
  if (draft.value.type === "api") {
    const trimmedUrl = draft.value.url.trim();
    if (!trimmedUrl) {
      error.value = "API 类型需要填写端点 URL";
      return;
    }
    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    } catch {
      error.value = "URL 必须是有效的 http(s) 地址";
      return;
    }
  } else {
    const trimmedRepo = draft.value.repo.trim();
    if (!trimmedRepo) {
      error.value = "GitHub 类型需要填写仓库名（owner/repo）";
      return;
    }
    const segments = trimmedRepo.split("/").filter(Boolean);
    if (segments.length !== 2 || segments.some((s) => !s.trim())) {
      error.value = "仓库名格式应为 owner/repo";
      return;
    }
  }
  const id = props.entry?.id ?? `skill-src-${Date.now().toString(36)}`;
  emit("save", {
    id,
    label: trimmedLabel,
    type: draft.value.type,
    url: draft.value.type === "api" ? draft.value.url.trim() : undefined,
    repo: draft.value.type === "github" ? draft.value.repo.trim() : undefined,
    enabled: props.entry?.enabled ?? true,
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
      class="flex max-h-[90vh] flex-col gap-0 overflow-hidden rounded-[14px] border-line bg-panel p-0 shadow-xl sm:max-w-[420px]"
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

      <div class="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 pb-4 pt-1">
        <DialogDescription class="text-[11px] leading-relaxed text-dim2">
          自定义技能市场源：接兼容 skills.sh 协议的 HTTP 端点，或按 GitHub 仓库名过滤已收录的技能。
        </DialogDescription>
        <input
          v-model="draft.label"
          class="w-full rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
          placeholder="源名称（如：My Skills）"
        />
        <select
          v-model="draft.type"
          class="w-full rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-accent"
        >
          <option value="api">自定义 API 端点</option>
          <option value="github">GitHub 仓库（skills.sh 已索引）</option>
        </select>

        <template v-if="draft.type === 'api'">
          <input
            v-model="draft.url"
            class="w-full rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            placeholder="https://my-registry.example.com"
          />
          <p class="text-[10px] leading-relaxed text-dim2">
            需兼容 skills.sh 协议：<code>/api/search?q=…</code> 和 <code>/api/download/{owner}/{repo}/{skill}</code>。
          </p>
        </template>

        <template v-else>
          <input
            v-model="draft.repo"
            class="w-full rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            placeholder="mattpocock/skills"
          />
          <p class="text-[10px] leading-relaxed text-dim2">仅搜索该仓库下已收录到 skills.sh 的技能；未收录的仓库搜不到结果。</p>
        </template>

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
        <button type="button" class="rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink" @click="save">
          {{ entry ? "保存" : "添加" }}
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>
