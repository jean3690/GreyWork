<script setup lang="ts">
/**
 * MCP 服务器新增/编辑弹窗（受控）。
 *
 * - `entry` 非空 = 编辑既有服务器（保存保留原 id/enabled，由父级负责）；
 * - `preset` = 登记草稿预填（官方 Registry「登记」入口），会带 envHint 提示；
 * - 收集字段后 emit `save(payload)`，父级组装成 McpServerEntry 落库。
 *
 * 远程传输（http/sse）配「请求头」KV（鉴权等）；stdio 配「环境变量」KV
 * （agent 启动子进程时注入）。值原样落盘，agent 会话声明时透传。
 */
import { computed, ref, watch } from "vue";
import type { McpServerEntry } from "@/stores/settings";
import type { McpRegistryEntry } from "@/lib/mcp-registry";
import CloseIcon from "@/features/shared/Icon.vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export interface McpDraftPayload {
  name: string;
  transport: McpServerEntry["transport"];
  url?: string;
  command?: string;
  args?: string[];
  headers?: Array<{ name: string; value: string }>;
  env?: Record<string, string>;
}

/** 登记预填草稿：标题/传输/端点 + 需要用户补的环境变量名提示。 */
export interface McpFormPreset {
  source?: "registry";
  registry?: McpRegistryEntry;
  name: string;
  transport: McpServerEntry["transport"];
  url?: string;
  /** stdio 草稿的启动命令（来自 registry 包类型，如 npx / uvx）。 */
  command?: string;
  args?: string[];
  /** 环境变量名清单（来自 registry 的 packages[].environmentVariables）。 */
  envHint?: string[];
}

interface KvRow {
  name: string;
  value: string;
}

const props = defineProps<{
  open: boolean;
  entry: McpServerEntry | null;
  preset?: McpFormPreset | null;
  /** 其他条目已占用的名称；MCP server name 必须在会话内唯一。 */
  existingNames?: string[];
}>();

const emit = defineEmits<{ save: [payload: McpDraftPayload]; cancel: [] }>();

const name = ref("");
const transport = ref<McpServerEntry["transport"]>("http");
const url = ref("");
const command = ref("");
const args = ref("");
const headerRows = ref<KvRow[]>([{ name: "", value: "" }]);
const envRows = ref<KvRow[]>([{ name: "", value: "" }]);
const error = ref<string | null>(null);
const showSecrets = ref(false);

function rowsToHeaders(rows: KvRow[]): Array<{ name: string; value: string }> {
  return rows.filter((row) => row.name.trim() && row.value.trim()).map((row) => ({ name: row.name.trim(), value: row.value.trim() }));
}

function rowsToEnv(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.name.trim();
    // 空值不注入，避免 registry 环境变量提示行意外覆盖进程原有环境。
    if (key && row.value.length > 0) out[key] = row.value;
  }
  return out;
}

/** 用 entry（编辑）或 preset（登记）或空表单重置草稿。 */
function resetDraft(): void {
  error.value = null;
  showSecrets.value = false;
  if (props.entry) {
    name.value = props.entry.name;
    transport.value = props.entry.transport;
    url.value = props.entry.url ?? "";
    command.value = props.entry.command ?? "";
    args.value = (props.entry.args ?? []).join("\n");
    headerRows.value =
      props.entry.headers && props.entry.headers.length > 0
        ? props.entry.headers.map((header) => ({ name: header.name, value: header.value }))
        : [{ name: "", value: "" }];
    envRows.value = Object.entries(props.entry.env ?? {}).map(([key, value]) => ({ name: key, value }));
    if (envRows.value.length === 0) envRows.value = [{ name: "", value: "" }];
  } else if (props.preset) {
    name.value = props.preset.name;
    transport.value = props.preset.transport;
    url.value = props.preset.url ?? "";
    command.value = props.preset.command ?? "";
    args.value = (props.preset.args ?? []).join("\n");
    headerRows.value = [{ name: "", value: "" }];
    envRows.value = (props.preset.envHint ?? []).map((envName) => ({ name: envName, value: "" }));
    if (envRows.value.length === 0) envRows.value = [{ name: "", value: "" }];
  } else {
    name.value = "";
    transport.value = "http";
    url.value = "";
    command.value = "";
    args.value = "";
    headerRows.value = [{ name: "", value: "" }];
    envRows.value = [{ name: "", value: "" }];
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) resetDraft();
  },
);

const editorTitle = computed(() => {
  if (props.entry) return "编辑 MCP 服务器";
  return props.preset?.source === "registry" ? "从官方 Registry 登记" : "添加 MCP 服务器";
});

function pushEmpty(rows: KvRow[]): void {
  rows.push({ name: "", value: "" });
}

function dropRow(rows: KvRow[], index: number): void {
  rows.splice(index, 1);
  if (rows.length === 0) rows.push({ name: "", value: "" });
}

function addHeaderRow(): void {
  pushEmpty(headerRows.value);
}

function removeHeaderRow(index: number): void {
  dropRow(headerRows.value, index);
}

function addEnvRow(): void {
  pushEmpty(envRows.value);
}

function removeEnvRow(index: number): void {
  dropRow(envRows.value, index);
}

function save(): void {
  const trimmedName = name.value.trim();
  if (!trimmedName) {
    error.value = "请先填服务器名";
    return;
  }
  if ((props.existingNames ?? []).some((candidate) => candidate.trim().toLocaleLowerCase() === trimmedName.toLocaleLowerCase())) {
    error.value = `服务器名「${trimmedName}」已存在`;
    return;
  }
  const trimmedUrl = url.value.trim();
  const trimmedCommand = command.value.trim();
  if (transport.value === "stdio" ? !trimmedCommand : !trimmedUrl) {
    error.value = transport.value === "stdio" ? "stdio 需要可执行命令" : "远程传输需要 URL";
    return;
  }
  if (transport.value !== "stdio") {
    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    } catch {
      error.value = "MCP URL 必须是有效的 http(s) 地址";
      return;
    }
  }
  const payload: McpDraftPayload = {
    name: trimmedName,
    transport: transport.value,
    headers: transport.value === "stdio" ? undefined : rowsToHeaders(headerRows.value),
    env: transport.value === "stdio" ? rowsToEnv(envRows.value) : undefined,
    ...(transport.value === "stdio"
      ? {
          command: trimmedCommand,
          // 每行一个 argv，保留参数内部空格；不经 shell，也不做引号展开。
          args: args.value
            .split(/\r?\n/)
            .map((arg) => arg.trim())
            .filter((arg) => arg.length > 0),
        }
      : { url: trimmedUrl }),
  };
  error.value = null;
  emit("save", payload);
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
        <DialogTitle class="text-[13px] font-medium text-foreground">{{ editorTitle }}</DialogTitle>
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
          HTTP/SSE 配请求头（鉴权等），stdio 配环境变量（agent 启动子进程时注入）。保存后由新建的 agent 会话透传。
        </DialogDescription>
        <p
          v-if="preset?.envHint && preset.envHint.length > 0"
          class="rounded-[8px] border border-amber-300/40 bg-amber-300/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200"
        >
          该服务声明需要环境变量（{{ preset.envHint.join("、") }}）。值为空时不会注入；一般需先在系统环境配好，或填进下方对应 KV 行。
        </p>

        <input
          v-model="name"
          class="w-full rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
          data-testid="mcp-name"
          placeholder="名称（agent 会看到这个名字）"
        />
        <select
          v-model="transport"
          class="w-full rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-accent"
        >
          <option value="http">HTTP（streamable）</option>
          <option value="sse">SSE</option>
          <option value="stdio">stdio（本地进程）</option>
        </select>
        <input
          v-if="transport !== 'stdio'"
          v-model="url"
          class="w-full rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
          data-testid="mcp-url"
          placeholder="https://mcp.deepwiki.com/mcp"
        />
        <template v-else>
          <input
            v-model="command"
            class="w-full rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            placeholder="npx 或 /usr/bin/npx"
          />
          <textarea
            v-model="args"
            data-testid="mcp-args"
            rows="3"
            class="w-full resize-y rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            placeholder="参数，每行一个（参数内部可含空格）"
          />
        </template>

        <!-- 远程：请求头 KV；stdio：环境变量 KV -->
        <template v-if="transport !== 'stdio'">
          <div class="pt-1">
            <div class="mb-1 flex items-center justify-between">
              <span class="text-[11px] font-medium text-dim">请求头（可选，鉴权等）</span>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="cursor-pointer text-[11px] text-dim transition-colors hover:text-foreground"
                  @click="showSecrets = !showSecrets"
                >
                  {{ showSecrets ? "隐藏值" : "显示值" }}
                </button>
                <button
                  type="button"
                  class="cursor-pointer text-[11px] text-dim transition-colors hover:text-foreground"
                  @click="addHeaderRow"
                >
                  ＋ 添加一行
                </button>
              </div>
            </div>
            <div v-for="(row, index) in headerRows" :key="index" class="mb-1 flex items-center gap-1.5">
              <input
                v-model="row.name"
                class="w-[42%] rounded-[8px] border border-line bg-panel-2 px-2 py-1 font-mono text-[11px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
                placeholder="Header-Name"
              />
              <input
                v-model="row.value"
                :type="showSecrets ? 'text' : 'password'"
                class="min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-2 py-1 font-mono text-[11px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
                placeholder="值"
              />
              <button
                type="button"
                class="cursor-pointer text-[11px] text-dim2 transition-colors hover:text-destructive"
                aria-label="删除此行"
                @click="removeHeaderRow(index)"
              >
                删
              </button>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="pt-1">
            <div class="mb-1 flex items-center justify-between">
              <span class="text-[11px] font-medium text-dim">环境变量（可选，注入子进程）</span>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="cursor-pointer text-[11px] text-dim transition-colors hover:text-foreground"
                  @click="showSecrets = !showSecrets"
                >
                  {{ showSecrets ? "隐藏值" : "显示值" }}
                </button>
                <button
                  type="button"
                  class="cursor-pointer text-[11px] text-dim transition-colors hover:text-foreground"
                  @click="addEnvRow"
                >
                  ＋ 添加一行
                </button>
              </div>
            </div>
            <div v-for="(row, index) in envRows" :key="index" class="mb-1 flex items-center gap-1.5">
              <input
                v-model="row.name"
                class="w-[42%] rounded-[8px] border border-line bg-panel-2 px-2 py-1 font-mono text-[11px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
                placeholder="KEY"
              />
              <input
                v-model="row.value"
                :type="showSecrets ? 'text' : 'password'"
                class="min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-2 py-1 font-mono text-[11px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
                placeholder="值"
              />
              <button
                type="button"
                class="cursor-pointer text-[11px] text-dim2 transition-colors hover:text-destructive"
                aria-label="删除此行"
                @click="removeEnvRow(index)"
              >
                删
              </button>
            </div>
          </div>
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
        <button
          data-testid="mcp-save"
          type="button"
          class="rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink"
          @click="save"
        >
          {{ entry ? "保存" : "添加" }}
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>
