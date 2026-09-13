<script setup lang="ts">
/**
 * 图标选择器：枚举 lib/icons.ts 全量图标名，网格点选。
 *
 * 三处使用者（ACP 后端 / 工作区 / 成员行）都要「改个图标」，各写一张网格会把
 * iconNames() 的遍历顺序和选中态样式复制三遍，故抽这一个受控组件：
 * 选中态只读 modelValue，写入走 update:modelValue——表单草稿（编辑未保存）与
 * 就地生效（侧栏点选）两种用法都能挂上来。
 */
import { computed } from "vue";
import { iconNames } from "../lib/icons";
import Icon from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    /** 当前选中的图标名；空串 = 未选（各项自行兜底到默认图标）。 */
    modelValue: string;
    columns?: number;
    clearable?: boolean;
    clearLabel?: string;
  }>(),
  { columns: 8, clearable: false, clearLabel: "默认" },
);

const emit = defineEmits<{ "update:modelValue": [name: string] }>();

const names = computed<string[]>(() => iconNames());

function pick(name: string): void {
  emit("update:modelValue", name);
}
</script>

<template>
  <div class="flex flex-col gap-1.5" data-testid="icon-picker">
    <div v-if="props.clearable" class="flex items-center gap-1">
      <button
        type="button"
        class="cursor-pointer rounded-[6px] border px-1.5 py-0.5 text-[11px] transition-colors"
        :class="props.modelValue ? 'border-line text-dim hover:text-foreground' : 'border-cyan/60 text-foreground'"
        data-testid="icon-picker-clear"
        @click="pick('')"
      >
        {{ props.clearLabel }}
      </button>
      <span class="text-[10.5px] text-dim2">{{ props.modelValue || props.clearLabel }}</span>
    </div>
    <div class="grid gap-1" :style="{ gridTemplateColumns: `repeat(${props.columns}, minmax(0, 1fr))` }">
      <button
        v-for="name in names"
        :key="name"
        type="button"
        class="grid size-7 cursor-pointer place-items-center rounded-[6px] border transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        :class="
          name === props.modelValue
            ? 'border-cyan/60 bg-cyan/10 text-foreground'
            : 'border-transparent text-dim hover:bg-panel-2 hover:text-foreground'
        "
        :data-testid="`icon-option-${name}`"
        :aria-pressed="name === props.modelValue"
        :aria-label="name"
        :title="name"
        @click="pick(name)"
      >
        <Icon :name="name" :size="14" />
      </button>
    </div>
  </div>
</template>
