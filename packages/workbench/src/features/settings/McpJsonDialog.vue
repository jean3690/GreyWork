<script setup lang="ts">
/**
 * MCP 服务器 JSON 配置弹窗（受控）。
 *
 * - 「导出」：把当前服务器列表序列化为 JSON（含 id/enabled），供备份 / 手动编辑；
 * - 「导入」：粘贴 JSON 覆盖既有列表（自动补 id/enabled，脏条目丢弃并提示）。
 *
 * 硬切换的逃生门：导入错了随时可从顶部「恢复默认」回到内置示例。
 */
import { computed, ref, watch } from "vue";
import type { McpServerEntry } from "@/stores/settings";
import { copyText } from "@/lib/clipboard";
import CloseIcon from "@/features/shared/Icon.vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

const MCP_TRANSPORTS: Record<string, true> = { http: true, sse: true, stdio: true };

const props = defineProps<{
  open: boolean;
  servers: McpServerEntry[];
}>();

const emit = defineEmits<{ import: [entries: McpServerEntry[]]; cancel: [] }>();

const jsonText = ref("");
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const valid = computed(() => jsonText.value.trim().length > 0 && !error.value);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    error.value = null;
    notice.value = null;
    jsonText.value = JSON.stringify(
      props.servers.map(({ id: _id, ...rest }) => rest),
      null,
      2,
    );
  },
);

/** 宽松解析：接受不带 id/enabled 的 wire 格式，也接受带完整本地字段的快照。 */
function parseServers(raw: unknown): McpServerEntry[] {
  if (!Array.isArray(raw)) throw new Error("JSON 必须是数组（服务器列表）");
  const out: McpServerEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const transport = entry.transport;
    if (!name || typeof transport !== "string" || !MCP_TRANSPORTS[transport]) continue;
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `mcp-${Date.now().toString(36)}-${out.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      transport: transport as McpServerEntry["transport"],
      url: typeof entry.url === "string" ? entry.url : undefined,
      command: typeof entry.command === "string" ? entry.command : undefined,
      args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : undefined,
      headers: Array.isArray(entry.headers)
        ? entry.headers
            .filter(
              (header): header is { name: string; value: string } =>
                !!header &&
                typeof header === "object" &&
                typeof (header as { name?: unknown }).name === "string" &&
                typeof (header as { value?: unknown }).value === "string",
            )
            .map((header) => ({ name: header.name, value: header.value }))
        : undefined,
      env:
        entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)
          ? Object.fromEntries(
              Object.entries(entry.env as Record<string, unknown>)
                .filter(([, value]) => typeof value === "string")
                .map(([key, value]) => [key, value as string]),
            )
          : undefined,
      enabled: entry.enabled === true,
    });
  }
  if (out.length === 0) throw new Error("没有解析出任何合法条目（每项至少需要 name 与合法 transport）");
  return out;
}

function importJson(): void {
  error.value = null;
  notice.value = null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.value);
  } catch (parseError) {
    error.value = `JSON 解析失败：${String(parseError).split("\n")[0]}`;
    return;
  }
  try {
    const entries = parseServers(parsed);
    const dropped = Array.isArray(parsed) ? parsed.length - entries.length : 0;
    notice.value = `已解析 ${entries.length} 条配置${dropped > 0 ? `（丢弃 ${dropped} 条无效条目）` : ""}，将覆盖当前服务器列表。`;
    emit("import", entries);
  } catch (importError) {
    error.value = String(importError);
  }
}

function copyJson(): void {
  void copyText(jsonText.value).then(() => {
    notice.value = "已复制到剪贴板。";
  });
}

function resetEditor(): void {
  error.value = null;
  notice.value = null;
  jsonText.value = JSON.stringify(
    props.servers.map(({ id: _id, ...rest }) => rest),
    null,
    2,
  );
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
      class="flex max-h-[90vh] flex-col gap-0 overflow-hidden rounded-[14px] border-line bg-panel p-0 shadow-xl sm:max-w-[560px]"
    >
      <div class="flex items-center justify-between px-4 pb-2 pt-3.5">
        <DialogTitle class="text-[13px] font-medium text-foreground">MCP JSON 配置</DialogTitle>
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
        <DialogDescription class="mb-2 text-[11px] leading-relaxed text-dim2">
          编辑 JSON 后点「导入」会<strong class="text-foreground">覆盖当前的 MCP 服务器列表</strong>。 支持两种格式：纯配置（name /
          transport / url / command / args / headers / env）或带 id / enabled 的完整快照； 缺 id / enabled
          会自动补默认值。导入出错可点右上「恢复默认」回到内置示例。
        </DialogDescription>
        <textarea
          v-model="jsonText"
          spellcheck="false"
          rows="16"
          class="w-full resize-y rounded-[8px] border border-line bg-panel-2 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground outline-none placeholder:text-dim2 focus:border-accent"
          placeholder='[{"name": "deepwiki", "transport": "http", "url": "https://mcp.deepwiki.com/mcp"}]'
        />
        <p v-if="error" class="text-[11px] text-destructive">{{ error }}</p>
        <p v-else-if="notice" class="text-[11px] text-dim">{{ notice }}</p>
      </div>

      <div class="flex justify-end gap-2 border-t border-line px-4 py-3">
        <button
          type="button"
          class="rounded-[8px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground"
          @click="resetEditor"
        >
          重置编辑
        </button>
        <button
          type="button"
          class="rounded-[8px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground"
          @click="copyJson"
        >
          复制
        </button>
        <button
          type="button"
          class="rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink transition-opacity disabled:opacity-60"
          :disabled="!valid"
          @click="importJson"
        >
          导入
        </button>
        <button
          type="button"
          class="rounded-[8px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground"
          @click="emit('cancel')"
        >
          取消
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>
