<script setup lang="ts">
/**
 * 云端 Office 服务商的扫码授权弹窗（从服务商行打开）。
 *
 * 回填方式是**粘贴回调 URL**：点「打开授权页」→ 系统浏览器跳到厂商同意页 → 用户同意 →
 * 浏览器停在 `redirect_uri?code=..&state=..` → 把地址栏整条 URL 粘回下面输入框 → 「完成授权」。
 * 不占本地端口，桌面端与服务端走同一条路。
 *
 * `state` 由本组件保管（宿主无状态，见 `stores/office-auth.ts`）：提交时原样回传，宿主据此
 * 确认这条回调确实出自本次授权。
 */
import { computed, ref, watch } from "vue";
import type { OfficeProviderConfig } from "@greywork/shell";
import CloseIcon from "@/features/shared/Icon.vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { openInSystemBrowser } from "@/lib/browser-backend";
import { officeAuthLabel, useOfficeAuthStore, type OfficeOAuthStatus } from "@/stores/office-auth";

const props = defineProps<{
  open: boolean;
  /** 要授权的服务商；为 null 时不显示内容。 */
  provider: OfficeProviderConfig | null;
}>();

const emit = defineEmits<{ close: [] }>();

const auth = useOfficeAuthStore();

/** 配置齐全才能授权：缺 clientId 换不了 token、缺回调地址授权页会直接拒绝。 */
const oauth = computed(() => props.provider?.oauth);
const configured = computed(() => Boolean(oauth.value?.clientId && oauth.value.redirectUri));

const authorizeUrl = ref<string | null>(null);
const state = ref<string | null>(null);
const callback = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
/** 本次授权得到的 / 查询到的状态；null = 还没动作。 */
const status = ref<OfficeOAuthStatus | null>(null);

const label = computed(() => officeAuthLabel(status.value ?? undefined));

function reset(): void {
  authorizeUrl.value = null;
  state.value = null;
  callback.value = "";
  busy.value = false;
  error.value = null;
  status.value = null;
  const clientId = oauth.value?.clientId.trim();
  if (clientId) void auth.refreshStatus(clientId).then(() => (status.value = auth.statuses[clientId] ?? null));
}

watch(
  () => props.open,
  (open) => {
    if (open) reset();
  },
);

/** 拼授权页地址（领 state）并交给系统浏览器打开。 */
async function openAuthorizePage(): Promise<void> {
  const config = oauth.value;
  if (!config) return;
  busy.value = true;
  error.value = null;
  try {
    const result = await auth.begin(config);
    authorizeUrl.value = result.authorizeUrl;
    state.value = result.state;
    await openInSystemBrowser(result.authorizeUrl);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

/** 交回调换 token。 */
async function submitCallback(): Promise<void> {
  const config = oauth.value;
  if (!config) return;
  const value = callback.value.trim();
  if (!value) {
    error.value = "请先粘贴浏览器地址栏里的整条回调 URL";
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    status.value = await auth.submit(config, value, state.value ?? undefined);
    callback.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

/** 退出登录：清宿主侧令牌。 */
async function logout(): Promise<void> {
  const clientId = oauth.value?.clientId.trim();
  if (!clientId) return;
  busy.value = true;
  error.value = null;
  try {
    await auth.logout(clientId);
    status.value = auth.statuses[clientId] ?? { authorized: false, expired: false };
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

function formatExpiry(ms: number): string {
  return new Date(ms).toLocaleString();
}

const inputClass =
  "w-full rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2.5 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-dim2 focus:border-accent";
const monoClass = `${inputClass} font-mono text-[12px]`;
const primaryBtn =
  "rounded-[calc(8px*var(--gw-radius-scale))] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink disabled:opacity-50";
const ghostBtn =
  "rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground disabled:opacity-50";
</script>

<template>
  <Dialog :open="open" @update:open="(next: boolean) => !next && emit('close')">
    <DialogContent
      :show-close-button="false"
      class="flex max-h-[90vh] flex-col gap-0 overflow-hidden rounded-[calc(14px*var(--gw-radius-scale))] border-line bg-panel p-0 shadow-xl sm:max-w-[520px]"
    >
      <div class="flex items-center justify-between px-4 pb-2 pt-3.5">
        <DialogTitle class="text-[13px] font-medium text-foreground">扫码授权 · {{ provider?.name ?? "" }}</DialogTitle>
        <button
          type="button"
          class="grid size-6 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
          aria-label="关闭"
          @click="emit('close')"
        >
          <CloseIcon name="close" :size="13" />
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 pb-4 pt-1">
        <DialogDescription class="text-[11px] leading-relaxed text-dim2">
          用系统浏览器打开厂商授权页，同意后浏览器会停在一个带 <code class="font-mono">code</code> 的地址上；把地址栏里那整条 URL
          复制回来粘到下面即可。
        </DialogDescription>

        <div
          v-if="!configured"
          class="rounded-[calc(10px*var(--gw-radius-scale))] border border-line bg-panel-2 p-3 text-[11px] leading-relaxed text-dim2"
          data-testid="office-oauth-need-config"
        >
          该服务商还没填授权配置。先点「编辑」填好 <code class="font-mono">client_id</code> 与回调地址，再回来授权。
        </div>

        <template v-else>
          <div class="flex items-center gap-2 text-[12px]">
            <span class="text-dim2">当前状态：</span>
            <span
              class="rounded-[calc(6px*var(--gw-radius-scale))] px-1.5 py-0.5 text-[11px]"
              :class="{
                'text-accent': label.tone === 'ok',
                'text-amber': label.tone === 'warn',
                'text-dim2': label.tone === 'muted',
              }"
              data-testid="office-oauth-status"
            >
              {{ label.text }}
            </span>
            <span v-if="status?.userId" class="font-mono text-[11px] text-dim2" data-testid="office-oauth-user-id"
              >uid: {{ status.userId }}</span
            >
            <span v-if="status?.expiresAt" class="text-[11px] text-dim2" data-testid="office-oauth-expires"
              >到期 {{ formatExpiry(status.expiresAt) }}</span
            >
          </div>

          <div class="rounded-[calc(10px*var(--gw-radius-scale))] border border-line bg-panel-2 p-3">
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-2">
                <span class="grid size-5 shrink-0 place-items-center rounded-full bg-panel text-[11px] text-dim2">1</span>
                <button type="button" :class="primaryBtn" :disabled="busy" data-testid="office-oauth-open" @click="openAuthorizePage">
                  打开授权页
                </button>
                <span class="text-[11px] text-dim2">在浏览器里完成同意</span>
              </div>

              <div class="flex items-start gap-2">
                <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-panel text-[11px] text-dim2">2</span>
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                  <span class="text-[11px] text-dim2">把浏览器地址栏里的整条 URL 粘回来</span>
                  <input
                    v-model="callback"
                    data-testid="office-oauth-callback"
                    :class="monoClass"
                    placeholder="https://…/callback?code=…&state=…"
                  />
                </div>
              </div>

              <div class="flex items-center gap-2">
                <span class="grid size-5 shrink-0 place-items-center rounded-full bg-panel text-[11px] text-dim2">3</span>
                <button type="button" :class="primaryBtn" :disabled="busy" data-testid="office-oauth-submit" @click="submitCallback">
                  完成授权
                </button>
              </div>
            </div>
          </div>

          <button
            type="button"
            :class="ghostBtn"
            :disabled="busy"
            data-testid="office-oauth-logout"
            class="hover:text-destructive"
            @click="logout"
          >
            退出登录
          </button>
        </template>

        <p v-if="error" class="text-[11px] text-destructive" data-testid="office-oauth-error">{{ error }}</p>
      </div>

      <div class="flex items-center justify-end border-t border-line px-4 py-3">
        <button type="button" :class="ghostBtn" @click="emit('close')">关闭</button>
      </div>
    </DialogContent>
  </Dialog>
</template>
