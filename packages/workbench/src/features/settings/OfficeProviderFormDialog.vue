<script setup lang="ts">
/**
 * 云端 Office 服务商的新增 / 编辑弹窗（受控，`entry` 为 null 即新增）。
 *
 * 收集字段后 emit `save(payload)`，父级补 id / family 再落库。
 * 凭证只填**环境变量名**（值由宿主从启动进程的环境里读），不落明文。
 *
 * 配方只认「填全或留空」：留空 = 这个服务商不做云端上传（预览仍走本地 viewer）；
 * 半填的配方会被 store 的归一化整条丢掉（静默），所以在这里就拦下来 —— 用户填了却没生效
 * 是最难查的一类问题。
 */
import { ref, watch } from "vue";
import { OFFICE_PROVIDER_KINDS, type OfficeProviderConfig, type OfficeProviderKind, type OfficeRecipe } from "@greywork/shell";
import CloseIcon from "@/features/shared/Icon.vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export interface OfficeProviderDraftPayload {
  name: string;
  kind: OfficeProviderKind;
  /** 下列标量字段一律带上（可为空串）：空串经 store 归一化后即被清掉，用户才能真的清空一项。 */
  baseUrl: string;
  credentialEnv: string;
  frameOrigin: string;
  docsUrl: string;
  /** 留空 = 该服务商不做云端上传。 */
  recipe?: OfficeRecipe;
}

const props = defineProps<{
  open: boolean;
  /** null = 新增，否则为被编辑项。 */
  entry: OfficeProviderConfig | null;
  /** 父级落库失败（归一化拒收等）回填进来：不关弹窗、不丢用户输入。 */
  error?: string | null;
}>();

const emit = defineEmits<{ save: [payload: OfficeProviderDraftPayload]; remove: []; cancel: [] }>();

const METHODS = ["POST", "PUT"] as const;
const BODIES = ["multipart", "raw-bytes"] as const;

const draft = ref({
  name: "",
  kind: "custom" as OfficeProviderKind,
  baseUrl: "",
  credentialEnv: "",
  frameOrigin: "",
  docsUrl: "",
  method: "POST" as OfficeRecipe["method"],
  url: "",
  body: "multipart" as OfficeRecipe["body"],
  fileField: "",
  contentType: "",
  credentialHeader: "",
  viewUrlPointer: "",
});
const localError = ref<string | null>(null);

/** 打开时按 `entry` 重填（受控：prop 是真源，组件自己不留状态）。 */
function reset(): void {
  const entry = props.entry;
  draft.value = {
    name: entry?.name ?? "",
    kind: entry?.kind ?? "custom",
    baseUrl: entry?.baseUrl ?? "",
    credentialEnv: entry?.credentialEnv ?? "",
    frameOrigin: entry?.frameOrigin ?? "",
    docsUrl: entry?.docsUrl ?? "",
    method: entry?.recipe?.method ?? "POST",
    url: entry?.recipe?.url ?? "",
    body: entry?.recipe?.body ?? "multipart",
    fileField: entry?.recipe?.fileField ?? "",
    contentType: entry?.recipe?.contentType ?? "",
    credentialHeader: entry?.recipe?.credentialHeader ?? "",
    viewUrlPointer: entry?.recipe?.viewUrlPointer ?? "",
  };
  localError.value = null;
}

watch(
  () => props.open,
  (open) => {
    if (open) reset();
  },
);

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

function save(): void {
  const name = draft.value.name.trim();
  if (!name) {
    localError.value = "请填写服务商名称";
    return;
  }

  // 配方：url 与 viewUrlPointer 是必填项，只要填了任一项就要求两项齐全。
  const url = draft.value.url.trim();
  const pointer = draft.value.viewUrlPointer.trim();
  let recipe: OfficeRecipe | undefined;
  if (url || pointer) {
    if (!url) {
      localError.value = "配方缺上传地址（url）";
      return;
    }
    if (!pointer) {
      localError.value = "配方缺取件指针（viewUrlPointer）—— 不知道该从响应哪里取文档地址";
      return;
    }
    if (!isHttpUrl(url)) {
      localError.value = "配方 url 必须是 http(s) 地址";
      return;
    }
    recipe = { method: draft.value.method, url, body: draft.value.body, viewUrlPointer: pointer };
    const fileField = draft.value.fileField.trim();
    if (fileField) recipe.fileField = fileField;
    const contentType = draft.value.contentType.trim();
    if (contentType) recipe.contentType = contentType;
    const credentialHeader = draft.value.credentialHeader.trim();
    if (credentialHeader) recipe.credentialHeader = credentialHeader;
  }

  // 内嵌域名会被拿去比对宿主 CSP 白名单，写错的表现是「预览被判成不可内嵌」，
  // 所以这里先按 origin 形态粗筛一道（精确校验在宿主侧，那里还会归一化）。
  const frameOrigin = draft.value.frameOrigin.trim();
  if (frameOrigin && !isHttpUrl(frameOrigin)) {
    localError.value = "内嵌域名必须是 http(s):// 开头的 origin（如 https://docs.example.com）";
    return;
  }

  localError.value = null;
  emit("save", {
    name,
    kind: draft.value.kind,
    baseUrl: draft.value.baseUrl.trim(),
    credentialEnv: draft.value.credentialEnv.trim(),
    frameOrigin,
    docsUrl: draft.value.docsUrl.trim(),
    ...(recipe ? { recipe } : {}),
  });
}

/** Dialog 收下 Esc / 点遮罩后关闭；open 归 false 即通知父级收起（受控：prop 是真源）。 */
function onOpenChange(next: boolean): void {
  if (!next) emit("cancel");
}

const inputClass =
  "w-full rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2.5 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-dim2 focus:border-accent";
const monoClass = `${inputClass} font-mono text-[12px]`;
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      :show-close-button="false"
      class="flex max-h-[90vh] flex-col gap-0 overflow-hidden rounded-[calc(14px*var(--gw-radius-scale))] border-line bg-panel p-0 shadow-xl sm:max-w-[520px]"
    >
      <div class="flex items-center justify-between px-4 pb-2 pt-3.5">
        <DialogTitle class="text-[13px] font-medium text-foreground">{{ entry ? "编辑服务商" : "新增服务商" }}</DialogTitle>
        <button
          type="button"
          class="grid size-6 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
          aria-label="关闭"
          @click="emit('cancel')"
        >
          <CloseIcon name="close" :size="13" />
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 pb-4 pt-1">
        <DialogDescription class="text-[11px] leading-relaxed text-dim2">
          把工作区里的 Office 文件交给该厂商上传，换回一个可嵌入的文档地址。凭证只填环境变量名，值由宿主从启动进程的环境里读，不会落盘。
        </DialogDescription>

        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-dim2">名称</span>
          <input v-model="draft.name" data-testid="office-provider-name" :class="inputClass" placeholder="如 自建文档服务" />
        </label>

        <div class="flex gap-2">
          <label class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="text-[11px] text-dim2">类别</span>
            <select v-model="draft.kind" data-testid="office-provider-kind" :class="inputClass">
              <option v-for="kind in OFFICE_PROVIDER_KINDS" :key="kind" :value="kind">{{ kind }}</option>
            </select>
          </label>
          <label class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="text-[11px] text-dim2">服务基址</span>
            <input
              v-model="draft.baseUrl"
              data-testid="office-provider-base-url"
              :class="monoClass"
              placeholder="https://open.example.com"
            />
          </label>
        </div>

        <div class="flex gap-2">
          <label class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="text-[11px] text-dim2">凭证环境变量</span>
            <input
              v-model="draft.credentialEnv"
              data-testid="office-provider-credential-env"
              :class="monoClass"
              placeholder="DOCS_ACCESS_TOKEN"
            />
          </label>
          <label class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="text-[11px] text-dim2">内嵌域名（origin）</span>
            <input
              v-model="draft.frameOrigin"
              data-testid="office-provider-frame-origin"
              :class="monoClass"
              placeholder="https://docs.example.com"
            />
          </label>
        </div>

        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-dim2">厂商文档地址</span>
          <input
            v-model="draft.docsUrl"
            data-testid="office-provider-docs-url"
            :class="monoClass"
            placeholder="https://open.example.com/docs/"
          />
        </label>

        <div class="rounded-[calc(10px*var(--gw-radius-scale))] border border-line bg-panel-2 p-3">
          <div class="mb-2 text-[12px] font-medium text-foreground">上传取件配方</div>
          <p class="mb-2.5 text-[10.5px] leading-relaxed text-dim2">
            留空 = 不做云端上传，预览走本地 viewer。填了就要求 url 与取件指针齐全 —— 半填的配方会被整条丢弃。
          </p>
          <div class="flex flex-col gap-2">
            <div class="flex gap-2">
              <label class="flex w-24 shrink-0 flex-col gap-1">
                <span class="text-[11px] text-dim2">方法</span>
                <select v-model="draft.method" data-testid="office-provider-method" :class="inputClass">
                  <option v-for="method in METHODS" :key="method" :value="method">{{ method }}</option>
                </select>
              </label>
              <label class="flex min-w-0 flex-1 flex-col gap-1">
                <span class="text-[11px] text-dim2">包体</span>
                <select v-model="draft.body" data-testid="office-provider-body" :class="inputClass">
                  <option v-for="body in BODIES" :key="body" :value="body">{{ body }}</option>
                </select>
              </label>
            </div>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-dim2">上传地址（<code class="font-mono">{filename}</code> 会被替换为 URL 编码后的文件名）</span>
              <input
                v-model="draft.url"
                data-testid="office-provider-url"
                :class="monoClass"
                placeholder="https://docs.example.com/upload?name={filename}"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-dim2">取件指针（JSON 指针，如 /data/url）</span>
              <input
                v-model="draft.viewUrlPointer"
                data-testid="office-provider-view-url-pointer"
                :class="monoClass"
                placeholder="/data/url"
              />
            </label>
            <div class="flex gap-2">
              <label class="flex min-w-0 flex-1 flex-col gap-1">
                <span class="text-[11px] text-dim2">文件字段名</span>
                <input v-model="draft.fileField" data-testid="office-provider-file-field" :class="monoClass" placeholder="file" />
              </label>
              <label class="flex min-w-0 flex-1 flex-col gap-1">
                <span class="text-[11px] text-dim2">Content-Type</span>
                <input
                  v-model="draft.contentType"
                  data-testid="office-provider-content-type"
                  :class="monoClass"
                  placeholder="按扩展名推断"
                />
              </label>
            </div>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-dim2">凭证请求头模板</span>
              <input
                v-model="draft.credentialHeader"
                data-testid="office-provider-credential-header"
                :class="monoClass"
                placeholder="Authorization: Bearer {{DOCS_ACCESS_TOKEN}}"
              />
            </label>
          </div>
        </div>

        <p v-if="localError || error" class="text-[11px] text-destructive">{{ localError || error }}</p>
      </div>

      <div class="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
        <button
          v-if="entry"
          type="button"
          data-testid="office-provider-remove"
          class="cursor-pointer rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-destructive"
          @click="emit('remove')"
        >
          删除该服务商
        </button>
        <span v-else />
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground"
            @click="emit('cancel')"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="office-provider-save"
            class="rounded-[calc(8px*var(--gw-radius-scale))] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink"
            @click="save"
          >
            保存
          </button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
