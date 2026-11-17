<script setup lang="ts">
/**
 * 设置 · 控制面：把桌面宿主接入 back/grey（Java 控制面）。
 *
 * 三件事：接入（入场码或登录 token）、看状态、手动同步一轮。语义边界直接写在面板里，
 * 而不是留给用户猜：
 * - 接入后宿主会注册并每 30s 心跳，运维台「宿主」页据此显示在线；
 * - 云端自动化任务由宿主认领执行，执行走**本机默认模型供应商**的单轮直连，
 *   不碰 ACP / 工具 —— 绑定 ACP 的任务回执失败，等应用内执行；
 * - token 只落宿主数据目录（0600），这里不回显、也不进设置存储。
 */
import { computed, onMounted, reactive, ref } from "vue";
import { hasHostCommands, invoke } from "@greywork/host-ipc";
import { useNoticeStore } from "@/stores/notice";
import { useUserAccountStore } from "@/stores/user-account";
import type { ControlPlaneStatus } from "@/lib/control-plane";

interface Outcome {
  name: string;
  ok: boolean;
  detail: string;
}

const notice = useNoticeStore();
const account = useUserAccountStore();
const hostAvailable = hasHostCommands();

const status = ref<ControlPlaneStatus | null>(null);
const busy = ref(false);
const error = ref("");
const form = reactive({
  baseUrl: "http://localhost:8080",
  mode: "enroll" as "enroll" | "token",
  email: "",
  code: "",
  token: "",
});

const envManaged = computed(() => status.value?.source === "env");
const connected = computed(() => status.value?.registered === true);
const canSubmit = computed(() => {
  if (busy.value || envManaged.value) return false;
  if (form.baseUrl.trim() === "") return false;
  return form.mode === "enroll" ? form.email.trim() !== "" && form.code.trim() !== "" : form.token.trim() !== "";
});

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function timeText(value: number | null): string {
  return value === null ? "—" : new Date(value).toLocaleTimeString();
}

async function refresh(): Promise<void> {
  if (!hostAvailable) return;
  try {
    status.value = await invoke<ControlPlaneStatus>("control_plane_status");
    if (status.value?.baseUrl) form.baseUrl = status.value.baseUrl;
  } catch (cause) {
    error.value = message(cause);
  }
}

async function connect(): Promise<void> {
  if (!canSubmit.value) return;
  busy.value = true;
  error.value = "";
  try {
    const payload =
      form.mode === "enroll"
        ? { baseUrl: form.baseUrl.trim(), email: form.email.trim(), code: form.code.trim() }
        : { baseUrl: form.baseUrl.trim(), token: form.token.trim() };
    const next = await invoke<ControlPlaneStatus>("control_plane_connect", payload);
    status.value = next;
    account.acceptStatus(next);
    void account.refresh();
    if (next.registered) {
      notice.success("已接入控制面", "宿主已注册，运维台的宿主页会显示在线");
      form.code = "";
      form.token = "";
    } else {
      notice.error("配置已保存，但注册失败", next.lastError ?? "稍后会自动重试");
    }
  } catch (cause) {
    error.value = message(cause);
  } finally {
    busy.value = false;
  }
}

async function runOnce(): Promise<void> {
  if (!hostAvailable || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await invoke<{ status: ControlPlaneStatus; outcomes: Outcome[] }>("control_plane_run_once", { limit: 5 });
    status.value = result.status;
    if (result.outcomes.length === 0) {
      notice.info("没有待执行的云端任务", "控制面到点后会自动入队，宿主每 30s 认领一次");
    }
    for (const outcome of result.outcomes) {
      if (outcome.ok) notice.success(outcome.name, outcome.detail);
      else notice.error(outcome.name + " 执行失败", outcome.detail);
    }
  } catch (cause) {
    error.value = message(cause);
  } finally {
    busy.value = false;
  }
}

async function disconnect(): Promise<void> {
  if (!hostAvailable || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    status.value = await invoke<ControlPlaneStatus>("control_plane_disconnect");
    account.acceptStatus(status.value);
    notice.info("已断开控制面", "宿主不再注册/心跳，云端任务不会被本机认领");
  } catch (cause) {
    error.value = message(cause);
  } finally {
    busy.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="flex flex-col gap-4">
    <p v-if="!hostAvailable" class="rounded-[calc(10px*var(--gw-radius-scale))] bg-panel-2 px-3 py-2 text-[11px] leading-[1.6] text-dim2">
      当前是浏览器预览态，没有宿主进程：控制面接入与云端任务认领不可用。请用桌面端或自托管服务端打开。
    </p>

    <!-- 接入状态 -->
    <div class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-4">
      <div class="mb-3 flex items-center justify-between gap-2">
        <span class="flex items-center gap-2 text-[13px] font-medium text-foreground">
          <span class="size-1.5 rounded-full" :class="connected ? 'bg-[var(--gw-mint,#3fb950)]' : 'bg-dim2'" aria-hidden="true" />
          {{ connected ? "已接入控制面" : status?.configured ? "已配置，未注册" : "未接入控制面" }}
        </span>
        <span class="flex gap-1.5">
          <button
            type="button"
            class="h-6 cursor-pointer rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!hostAvailable || busy || !status?.configured"
            data-testid="controlplane-run-once"
            @click="runOnce"
          >
            立即同步
          </button>
          <button
            type="button"
            class="h-6 cursor-pointer rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!hostAvailable || busy || !status?.configured || envManaged"
            data-testid="controlplane-disconnect"
            @click="disconnect"
          >
            断开
          </button>
        </span>
      </div>

      <dl class="grid grid-cols-[88px_minmax(0,1fr)] gap-y-1.5 text-[11.5px]" data-testid="controlplane-status">
        <dt class="text-dim2">地址</dt>
        <dd class="truncate font-mono text-foreground">{{ status?.baseUrl ?? "—" }}</dd>
        <dt class="text-dim2">账号</dt>
        <dd class="truncate text-foreground">{{ status?.email ?? "—" }}</dd>
        <dt class="text-dim2">心跳</dt>
        <dd class="text-foreground">每 {{ status?.tickSecs ?? 30 }}s · 上次 {{ timeText(status?.lastHeartbeatAt ?? null) }}</dd>
        <dt class="text-dim2">最近任务</dt>
        <dd class="truncate text-foreground">
          <template v-if="status?.lastOutcome">
            <span :class="status.lastOutcome.ok ? 'text-foreground' : 'text-[var(--gw-red,#f85149)]'">
              {{ status.lastOutcome.ok ? "成功" : "失败" }} · {{ status.lastOutcome.name }}
            </span>
            <span class="text-dim2"> — {{ status.lastOutcome.detail }}</span>
          </template>
          <template v-else>—</template>
        </dd>
      </dl>

      <p v-if="status?.lastError" class="mt-2 break-words text-[11px] leading-relaxed text-[var(--gw-red,#f85149)]">
        {{ status.lastError }}
      </p>
      <p v-if="envManaged" class="mt-2 text-[11px] leading-relaxed text-dim2">
        当前配置来自环境变量 GREYWORK_CONTROL_URL / GREYWORK_CONTROL_TOKEN：要改请改变量后重启，界面不能覆盖。
      </p>
    </div>

    <!-- 接入表单 -->
    <div class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-4">
      <div class="mb-3 flex items-center justify-between gap-2">
        <span class="text-[13px] font-medium text-foreground">接入控制面</span>
        <select
          v-model="form.mode"
          class="cursor-pointer rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel-2 px-1.5 py-1 text-[11px] text-foreground outline-none focus:border-line-2"
          data-testid="controlplane-mode"
          aria-label="凭据方式"
        >
          <option value="enroll">入场码（推荐）</option>
          <option value="token">登录 token</option>
        </select>
      </div>

      <div class="flex flex-col gap-2.5">
        <label class="flex items-center gap-2">
          <span class="w-20 shrink-0 text-[11.5px] text-dim2">控制面地址</span>
          <input
            v-model="form.baseUrl"
            class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-line-2 disabled:opacity-60"
            placeholder="http://127.0.0.1:8080"
            :disabled="envManaged"
            data-testid="controlplane-base-url"
          />
        </label>

        <template v-if="form.mode === 'enroll'">
          <label class="flex items-center gap-2">
            <span class="w-20 shrink-0 text-[11.5px] text-dim2">邮箱</span>
            <input
              v-model="form.email"
              class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-line-2 disabled:opacity-60"
              placeholder="you@example.com"
              autocomplete="username"
              :disabled="envManaged"
              data-testid="controlplane-email"
            />
          </label>
          <label class="flex items-center gap-2">
            <span class="w-20 shrink-0 text-[11.5px] text-dim2">入场码</span>
            <input
              v-model="form.code"
              class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] uppercase text-foreground outline-none placeholder:text-dim2 focus:border-line-2 disabled:opacity-60"
              placeholder="在运维台 → 入场码 签发"
              :disabled="envManaged"
              data-testid="controlplane-code"
            />
          </label>
        </template>
        <label v-else class="flex items-center gap-2">
          <span class="w-20 shrink-0 text-[11.5px] text-dim2">登录 token</span>
          <input
            v-model="form.token"
            type="password"
            class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-line-2 disabled:opacity-60"
            placeholder="会话 token（Bearer）"
            autocomplete="off"
            :disabled="envManaged"
            data-testid="controlplane-token"
          />
        </label>
      </div>

      <p v-if="error" class="mt-2 break-words text-[11px] leading-relaxed text-[var(--gw-red,#f85149)]">{{ error }}</p>

      <div class="mt-3 flex items-center gap-2">
        <button
          type="button"
          class="h-7 cursor-pointer rounded-[calc(7px*var(--gw-radius-scale))] bg-accent px-3 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!hostAvailable || !canSubmit"
          data-testid="controlplane-connect"
          @click="connect"
        >
          {{ busy ? "处理中…" : "接入 / 保存" }}
        </button>
        <span class="text-[11px] text-dim2">入场码可在运维台签发；接入后 token 只保存在宿主数据目录（0600）。</span>
      </div>
    </div>

    <!-- 边界说明 -->
    <p class="rounded-[calc(10px*var(--gw-radius-scale))] bg-panel-2 px-3 py-2 text-[11px] leading-[1.7] text-dim2">
      云端自动化任务由本机认领执行：只走<strong>本机默认模型供应商</strong>的单轮直连（不调 ACP、不给工具）。 绑定 ACP
      的任务会回执失败并在运维台留下记录，需要在应用内手动执行。宿主离线期间任务留在控制面排队，回来后照常认领。
    </p>
  </div>
</template>
