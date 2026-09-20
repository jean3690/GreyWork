<script setup lang="ts">
import { computed, ref } from "vue";
import PluginRenderLoop from "@/features/plugins/PluginRenderLoop.vue";
import { runDeclarativeAction, setDeclarativePluginValue, useDeclarativePluginState } from "./declarative-state";
import type { DeclarativeAction, DeclarativeField, DeclarativePage, DeclarativeValue } from "./market-types";

const props = defineProps<{
  pluginId: string;
  modeId: string;
  page: DeclarativePage;
  invoke?: (handler: string, state: Readonly<Record<string, DeclarativeValue>>) => Promise<Record<string, DeclarativeValue> | void>;
  /** 声明的渲染循环（worker render handler + fps + 画布尺寸）；仅 worker 包有。 */
  render?: { handler: string; fps?: number; width?: number; height?: number };
  /** 渲染通道：worker render handler 返回指令集（非 patch）。 */
  renderChannel?: (handler: string, state: Readonly<Record<string, DeclarativeValue>>) => Promise<unknown>;
}>();

const busyAction = ref<string | null>(null);
const actionError = ref("");

const fields = computed(() => props.page.fields ?? []);
const actions = computed(() => props.page.actions ?? []);
const outputs = computed(() => props.page.outputs ?? []);
const state = useDeclarativePluginState(`${props.pluginId}/${props.modeId}`, fields.value);

function fieldValue(field: DeclarativeField): DeclarativeValue {
  return state[field.key] ?? field.default;
}

function updateField(field: DeclarativeField, event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  let value: DeclarativeValue = input.value;
  if (field.kind === "number") {
    if (!Number.isFinite(input.valueAsNumber)) return;
    value = Math.min(field.max ?? Number.POSITIVE_INFINITY, Math.max(field.min ?? Number.NEGATIVE_INFINITY, input.valueAsNumber));
  }
  if (field.kind === "toggle") value = input.checked;
  setDeclarativePluginValue(`${props.pluginId}/${props.modeId}`, state, field.key, value);
}

async function run(action: DeclarativeAction): Promise<void> {
  actionError.value = "";
  if (action.operation.type !== "invoke") {
    runDeclarativeAction(`${props.pluginId}/${props.modeId}`, state, fields.value, action);
    return;
  }
  if (!props.invoke || busyAction.value) return;
  busyAction.value = action.id;
  try {
    const patch = await props.invoke(action.operation.handler, { ...state });
    if (!patch) return;
    for (const field of fields.value) {
      const value = patch[field.key];
      if (value !== undefined) setDeclarativePluginValue(`${props.pluginId}/${props.modeId}`, state, field.key, value);
    }
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    busyAction.value = null;
  }
}

function actionClass(action: DeclarativeAction): string {
  if (action.style === "danger") return "border-orange/40 bg-orange/10 text-orange hover:bg-orange/15";
  if (action.style === "secondary") return "border-line-2 bg-panel-2 text-foreground hover:border-dim2";
  return "border-accent bg-accent text-accent-ink hover:opacity-90";
}
</script>

<template>
  <main class="mx-auto flex h-full w-full max-w-[860px] flex-col gap-5 overflow-y-auto p-4 sm:p-7" data-testid="declarative-plugin-view">
    <header class="relative overflow-hidden rounded-[16px] border border-line-2 bg-panel-2 px-5 py-6 sm:px-7">
      <div class="pointer-events-none absolute -right-12 -top-20 size-52 rounded-full border border-cyan/30" />
      <div class="pointer-events-none absolute -right-2 -top-12 size-32 rounded-full border border-blue/30" />
      <p v-if="props.page.eyebrow" class="text-[11px] font-medium uppercase tracking-[0.14em] text-cyan">
        {{ props.page.eyebrow }}
      </p>
      <h1 class="relative mt-1 text-[24px] font-semibold tracking-[-0.02em] text-foreground">{{ props.page.heading }}</h1>
    </header>
    <PluginRenderLoop
      v-if="props.render && renderChannel"
      :render="renderChannel"
      :handler="props.render.handler"
      :fps="props.render.fps"
      :width="props.render.width"
      :height="props.render.height"
      :state="() => ({ ...state })"
      data-testid="declarative-plugin-render"
    />

    <section v-if="outputs.length" class="grid gap-3 sm:grid-cols-2" data-testid="declarative-plugin-outputs">
      <article v-for="output in outputs" :key="output.valueKey" class="rounded-[13px] border border-line bg-panel px-4 py-3">
        <p class="text-[11px] text-dim2">{{ output.label }}</p>
        <output
          class="mt-1 block font-mono text-[22px] font-semibold text-foreground"
          :data-testid="`declarative-output-${output.valueKey}`"
        >
          {{ state[output.valueKey] }}<span v-if="output.suffix" class="ml-1 text-[11px] font-normal text-dim2">{{ output.suffix }}</span>
        </output>
      </article>
    </section>

    <section v-if="fields.length" class="rounded-[14px] border border-line bg-panel p-4 sm:p-5" data-testid="declarative-plugin-fields">
      <div class="grid gap-4 sm:grid-cols-2">
        <label
          v-for="field in fields"
          :key="field.key"
          class="flex min-w-0 flex-col gap-1.5"
          :class="field.kind === 'toggle' ? 'sm:col-span-2' : ''"
        >
          <span class="text-[12px] font-medium text-foreground">{{ field.label }}</span>
          <span v-if="field.description" class="text-[11px] leading-5 text-dim2">{{ field.description }}</span>
          <input
            v-if="field.kind === 'text'"
            type="text"
            class="h-9 rounded-[8px] border border-line-2 bg-panel-2 px-3 text-[12px] text-foreground outline-none transition-colors focus:border-cyan"
            :value="fieldValue(field)"
            :maxlength="field.maxLength"
            :data-testid="`declarative-field-${field.key}`"
            @input="updateField(field, $event)"
          />
          <input
            v-else-if="field.kind === 'number'"
            type="number"
            class="h-9 rounded-[8px] border border-line-2 bg-panel-2 px-3 font-mono text-[12px] text-foreground outline-none transition-colors focus:border-cyan"
            :value="fieldValue(field)"
            :min="field.min"
            :max="field.max"
            :step="field.step"
            :data-testid="`declarative-field-${field.key}`"
            @input="updateField(field, $event)"
          />
          <span v-else class="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              class="size-4 accent-cyan"
              :checked="Boolean(fieldValue(field))"
              :data-testid="`declarative-field-${field.key}`"
              @change="updateField(field, $event)"
            />
            <span class="text-[12px] text-dim">{{ fieldValue(field) ? "已开启" : "已关闭" }}</span>
          </span>
        </label>
      </div>
    </section>

    <p v-if="actionError" class="rounded-[8px] border border-orange/40 bg-orange/10 px-3 py-2 text-[11px] text-orange" role="alert">
      {{ actionError }}
    </p>

    <section v-if="actions.length" class="flex flex-wrap items-center gap-2" data-testid="declarative-plugin-actions">
      <button
        v-for="action in actions"
        :key="action.id"
        type="button"
        class="h-9 cursor-pointer rounded-[8px] border px-4 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        :class="actionClass(action)"
        :disabled="busyAction !== null"
        :data-testid="`declarative-action-${action.id}`"
        @click="run(action)"
      >
        {{ busyAction === action.id ? "…" : action.label }}
      </button>
    </section>
  </main>
</template>
