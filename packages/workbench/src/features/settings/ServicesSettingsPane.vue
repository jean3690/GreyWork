<script setup lang="ts">
/**
 * 设置 · 服务分区：第三方云端服务的接入配置。
 *
 * 本期只有 office 族真正被消费（云端 Office 预览，见 `crates/greywork-host/src/office.rs`）。
 * 其余三族（model / storage / scheduler）在 `@greywork/shell` 的 services.ts 里只是类型接缝、
 * 还没有行为 —— 摆出来只会让人以为能用，所以这一页只渲染 office 族。
 *
 * **两处硬边界必须如实说清**（不说清的表现就是「配了却不生效」）：
 * 1. 能不能内嵌取决于**宿主**的 CSP：桌面壳写死在打包配置里，只有宿主列出的那几个 origin
 *    能进 iframe；服务端则来自 `GREYWORK_FRAME_ORIGINS`。面板里填内嵌域名**不会**自动放行。
 * 2. 凭证只填环境变量名，值由宿主从**启动进程**的环境里读。改了变量名、或忘了 export，
 *    预览就会失败 —— 所以这里把「声明了但没设置」的变量名直接标出来。
 */
import { computed, onMounted, ref, watch } from "vue";
import { hasHostCommands } from "@greywork/host-ipc";
import type { OfficeProviderConfig } from "@greywork/shell";
import Icon from "@/features/shared/Icon.vue";
import OfficeProviderFormDialog, { type OfficeProviderDraftPayload } from "@/features/settings/OfficeProviderFormDialog.vue";
import { useSettingsStore } from "@/stores/settings";
import { useOfficeHostStore } from "@/stores/office-host";

const settings = useSettingsStore();
const host = useOfficeHostStore();

/** 浏览器预览态没有宿主命令，这一页的开关都无从生效 —— 如实说明，而不是给点了没反应的按钮。 */
const hostAvailable = hasHostCommands();

const dialogOpen = ref(false);
const dialogEntry = ref<OfficeProviderConfig | null>(null);
const dialogError = ref<string | null>(null);

/** 服务商声明的凭证变量名（去重）—— 一次问宿主它们有没有设。 */
const declaredEnvNames = computed(() => [
  ...new Set(settings.officeProviders.map((provider) => provider.credentialEnv?.trim()).filter((name): name is string => Boolean(name))),
]);

/** 当前宿主可内嵌的 origin；`originsLoaded` 为假 = 还没取到（或没有宿主），不谎报为空。 */
const allowListText = computed(() => {
  if (!hostAvailable) return "浏览器预览态没有宿主，云端预览不可用。";
  if (!host.originsLoaded) return "读取中…";
  return host.embeddableFrameOrigins.join("、") || "（无：宿主未允许任何外部域名内嵌）";
});

function refreshHostFacts(): void {
  if (!hostAvailable) return;
  void host.loadEnvPresence(declaredEnvNames.value);
}

onMounted(refreshHostFacts);
// 变量名清单随用户增删服务商而变，标出的「未设置」必须跟着走。
watch(declaredEnvNames, refreshHostFacts);

function setEnabled(provider: OfficeProviderConfig, enabled: boolean): void {
  settings.upsertServiceProvider({ ...provider, enabled });
}

function select(id: string): void {
  settings.selectOfficeProvider(id);
}

function startAdd(): void {
  dialogEntry.value = null;
  dialogError.value = null;
  dialogOpen.value = true;
}

function startEdit(provider: OfficeProviderConfig): void {
  dialogEntry.value = provider;
  dialogError.value = null;
  dialogOpen.value = true;
}

function closeDialog(): void {
  dialogEntry.value = null;
  dialogError.value = null;
  dialogOpen.value = false;
}

function saveDraft(payload: OfficeProviderDraftPayload): void {
  const current = dialogEntry.value;
  const provider: OfficeProviderConfig = current
    ? { ...current, ...payload }
    : { id: `custom-office-${Date.now().toString(36)}`, family: "office", enabled: true, ...payload };
  if (!settings.upsertServiceProvider(provider)) {
    // 归一化拒收（形状不合法）—— 就地报错，不关弹窗、不丢用户输入。
    dialogError.value = "保存失败：配置形状不合法，请检查各字段";
    return;
  }
  // 新增的那条直接选中：用户刚配好一个服务商，下一步十有八九就是用它。
  if (!current) settings.selectOfficeProvider(provider.id);
  closeDialog();
}

function removeDraft(): void {
  const current = dialogEntry.value;
  if (!current) return;
  settings.removeServiceProvider(current.id);
  closeDialog();
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-3 flex items-center justify-between gap-2">
        <span class="text-[13px] font-medium text-foreground">云端 Office 预览</span>
        <span class="flex gap-1.5">
          <button
            type="button"
            data-testid="office-provider-add"
            class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
            @click="startAdd"
          >
            ＋ 新增服务商
          </button>
          <button
            type="button"
            data-testid="office-provider-reset"
            class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
            @click="settings.resetServiceProviders()"
          >
            恢复默认
          </button>
        </span>
      </div>

      <div class="flex flex-col gap-1.5">
        <div
          v-for="provider in settings.officeProviders"
          :key="provider.id"
          :data-testid="`office-provider-${provider.id}`"
          class="flex items-center gap-2.5 rounded-[10px] border px-3 py-2 transition-colors"
          :class="provider.id === settings.selectedOfficeProviderId ? 'border-line-2 bg-panel-2' : 'border-transparent hover:bg-panel-2'"
        >
          <input
            type="checkbox"
            class="size-4 cursor-pointer accent-[var(--accent)]"
            :checked="provider.enabled"
            :aria-label="`启用 ${provider.name}`"
            :data-testid="`office-provider-enable-${provider.id}`"
            @change="setEnabled(provider, ($event.target as HTMLInputElement).checked)"
          />
          <button
            type="button"
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
            :aria-pressed="provider.id === settings.selectedOfficeProviderId"
            @click="select(provider.id)"
          >
            <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">{{ provider.name }}</span>
            <span class="shrink-0 font-mono text-[11px] text-dim2">{{ provider.kind }}</span>
            <span class="shrink-0 text-[11px]" :class="provider.recipe ? 'text-accent' : 'text-dim2'">
              {{ provider.recipe ? "配方已填" : "未填配方" }}
            </span>
          </button>
          <button
            type="button"
            class="shrink-0 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
            :data-testid="`office-provider-edit-${provider.id}`"
            @click="startEdit(provider)"
          >
            编辑
          </button>
        </div>
      </div>

      <p class="mt-2 text-[11px] leading-relaxed text-dim2">
        启用并填好配方的服务商，才会接管 docx / pptx / xlsx / xls 与老格式 Office 文件的预览；任何一个环节失败都会回落到本地
        viewer，不会出现「配了云端反而打不开」。
      </p>
    </div>

    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        <Icon name="earth" :size="13" class="text-dim" />
        当前宿主可内嵌的域名
      </div>
      <p class="text-[11px] leading-relaxed text-dim2" data-testid="office-provider-allow-list">{{ allowListText }}</p>
      <p class="mt-2 text-[11px] leading-relaxed text-dim2">
        厂商返回的文档地址必须落在上面这份白名单里，否则 iframe 会被宿主的 CSP 拦掉（白屏，且控制台之外看不到报错）——
        这时预览会如实回落到本地 viewer。桌面端的白名单写死在打包配置里，无法自行添加；服务端请把 origin 加进
        <code class="font-mono">GREYWORK_FRAME_ORIGINS</code>。在服务商里填内嵌域名只是声明，不会自动放行。
      </p>
      <p
        v-if="host.envMissing.length > 0"
        class="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber"
        data-testid="office-provider-env-missing"
      >
        <Icon name="shield" :size="12" class="mt-0.5 shrink-0" />
        以下凭证环境变量尚未设置：{{ host.envMissing.join("、") }}。先在启动 GreyWork 的终端里 export，再从同一终端启动。
      </p>
    </div>

    <OfficeProviderFormDialog
      :open="dialogOpen"
      :entry="dialogEntry"
      :error="dialogError"
      @save="saveDraft"
      @remove="removeDraft"
      @cancel="closeDialog"
    />
  </div>
</template>
