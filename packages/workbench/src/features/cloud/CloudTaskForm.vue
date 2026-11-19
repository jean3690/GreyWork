<script setup lang="ts">
import { computed, reactive } from "vue";
import { type CloudHost, type CloudTask, type CloudTaskInput } from "@/lib/cloud-api";
import { validateCron } from "@/lib/cron";
import { useUserAccountStore } from "@/stores/user-account";
import { formatCloudTime, type CloudTaskDraft } from "./task-draft";
const props = defineProps<{ task: CloudTask | null; hosts: CloudHost[]; zone: string; saving: boolean; draft?: CloudTaskDraft | null }>();
const emit = defineEmits<{ save: [input: CloudTaskInput]; cancel: [] }>();
const account = useUserAccountStore();
const form = reactive({
  name: props.task?.name ?? props.draft?.name ?? "",
  intent: props.task?.intent ?? props.draft?.intent ?? "",
  mode: props.task?.onceAt || props.draft?.onceAt ? "once" : "cron",
  cron: props.task?.cronExpr ?? props.draft?.cron ?? "0 9 * * *",
  onceAt: props.task?.onceAt?.slice(0, 16) ?? (props.draft?.onceAt ? formatCloudTime(props.draft.onceAt, props.zone) : ""),
  device:
    props.task?.hostDeviceId ??
    (props.hosts.some((host) => host.deviceId === String(account.session?.device.id)) ? String(account.session?.device.id) : ""),
  offlinePolicy: props.task?.offlinePolicy ?? "replay",
  enabled: props.task?.enabled ?? true,
  model: props.task?.model ?? "",
});
const unsupported = computed(() => props.task?.execution === "cloud" || !!props.task?.acpProviderId);
const onceInPast = computed(
  () => form.mode === "once" && form.enabled && !!form.onceAt && form.onceAt <= formatCloudTime(Date.now(), props.zone),
);
const valid = computed(
  () =>
    !unsupported.value &&
    !!form.name.trim() &&
    !!form.intent.trim() &&
    (form.mode === "once" ? !!form.onceAt && !onceInPast.value : validateCron(form.cron) === null),
);
const cronProblem = computed(() => form.mode === "cron" && validateCron(form.cron) !== null);
function save(): void {
  if (!valid.value) return;
  emit("save", {
    name: form.name.trim(),
    intent: form.intent.trim(),
    schedule: form.mode === "cron" ? form.cron.trim() : form.onceAt,
    cronExpr: form.mode === "cron" ? form.cron.trim() : null,
    onceAt: form.mode === "once" ? form.onceAt + ":00" : null,
    execution: "host",
    hostDeviceId: form.device || null,
    offlinePolicy: form.offlinePolicy,
    enabled: form.enabled,
    acpProviderId: null,
    target: "客户端模型",
    model: form.model.trim() || null,
  });
}
const fieldClass = "w-full rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel px-3 py-2 text-[12px] text-foreground";
</script>

<template>
  <form class="mb-5 space-y-3 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel p-4" @submit.prevent="save">
    <h3 class="text-[14px] font-semibold text-foreground">{{ task ? "编辑云端任务" : "新建云端任务" }}</h3>
    <p v-if="unsupported" role="alert" class="text-[12px] text-dim">
      此任务使用云端或 ACP 执行，请在原创建端编辑。这里不会覆盖其执行配置。
    </p>
    <label class="block text-[12px] text-dim"
      >任务名称<input v-model="form.name" :class="fieldClass" class="mt-1" maxlength="128" required
    /></label>
    <label class="block text-[12px] text-dim"
      >执行指令<textarea v-model="form.intent" :class="fieldClass" class="mt-1" rows="3" required />
    </label>
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="text-[12px] text-dim"
        >触发方式<select v-model="form.mode" :class="fieldClass" class="mt-1">
          <option value="cron">循环（Cron）</option>
          <option value="once">只执行一次</option>
        </select></label
      >
      <label v-if="form.mode === 'cron'" class="text-[12px] text-dim"
        >Cron 表达式<input v-model="form.cron" :class="fieldClass" class="mt-1 font-mono" placeholder="0 9 * * *" required /><span
          v-if="cronProblem"
          class="text-red-400"
          >请输入合法的五段 Cron：分 时 日 月 周</span
        ></label
      >
      <label v-else class="text-[12px] text-dim"
        >执行时间（{{ zone }}）<input v-model="form.onceAt" type="datetime-local" :class="fieldClass" class="mt-1" required /><span
          v-if="onceInPast"
          class="text-red-400"
          >请选择未来的执行时间</span
        ></label
      >
      <label class="text-[12px] text-dim"
        >执行设备<select v-model="form.device" :class="fieldClass" class="mt-1">
          <option value="">任意在线设备（仅一个执行）</option>
          <option v-for="host in hosts" :key="host.deviceId" :value="host.deviceId">
            {{ host.name }} · {{ host.alive ? "在线" : "离线" }}
          </option>
        </select></label
      >
      <label class="text-[12px] text-dim"
        >设备离线时<select v-model="form.offlinePolicy" :class="fieldClass" class="mt-1">
          <option value="replay">上线后补跑</option>
          <option value="skip">离线跳过，并保留记录</option>
        </select></label
      >
    </div>
    <label class="block text-[12px] text-dim"
      >模型（可选，留空使用设备默认模型）<input v-model="form.model" :class="fieldClass" class="mt-1" maxlength="128"
    /></label>
    <label class="flex items-center gap-2 text-[12px] text-dim"><input v-model="form.enabled" type="checkbox" />保存后启用</label>
    <p class="text-[11px] text-dim2">
      服务器按 {{ zone }} 排期，客户端宿主执行本机 OpenAI 兼容模型的单轮请求，不使用工具或
      ACP。选择“补跑”会保留每个到期任务；执行设备需要保持 GreyWork 运行。
    </p>
    <div class="flex justify-end gap-3">
      <button type="button" class="text-[12px] text-dim" :disabled="saving" @click="emit('cancel')">取消</button>
      <button
        type="submit"
        class="rounded-[calc(6px*var(--gw-radius-scale))] bg-cyan/15 px-4 py-2 text-[12px] text-cyan disabled:opacity-40"
        :disabled="!valid || saving"
      >
        {{ saving ? "保存中…" : "保存到云端" }}
      </button>
    </div>
  </form>
</template>
