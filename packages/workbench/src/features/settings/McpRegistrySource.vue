<script setup lang="ts">
/** 市场与设置共用来源选择；只提交地址，搜索与设置持久化由父级负责。 */
defineProps<{ modelValue: string; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const official = "https://registry.modelcontextprotocol.io";
function commit(event: Event): void {
  emit("update:modelValue", (event.target as HTMLInputElement).value.trim());
}
</script>

<template>
  <div class="space-y-1.5" data-testid="mcp-registry-source">
    <label class="flex items-center gap-2">
      <span class="w-14 shrink-0 text-[10.5px] text-dim2">Registry</span>
      <input
        :value="modelValue"
        class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[11px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
        placeholder="留空使用 Java 后端；也可填写第三方 Registry 地址"
        :disabled="disabled"
        data-testid="mcp-registry-url"
        @change="commit"
        @keydown.enter.prevent="commit"
      />
    </label>
    <div class="flex flex-wrap items-center gap-2 text-[10.5px] text-dim2">
      <button type="button" class="text-accent disabled:opacity-50" :disabled="disabled" @click="emit('update:modelValue', '')">
        Java 后端（默认）
      </button>
      <button type="button" class="text-accent disabled:opacity-50" :disabled="disabled" @click="emit('update:modelValue', official)">
        官方市场
      </button>
      <span>{{ modelValue ? "当前使用自定义来源" : "跟随账号服务器；未配置时使用本地 8080（专用环境变量可覆盖）" }}</span>
    </div>
  </div>
</template>
