<script setup lang="ts">
/** 设置 · appearance 分区：主题配色 / 明暗模式 / 界面字号 / 界面语言。 */
import { useI18n } from "vue-i18n";
import Icon from "@/features/shared/Icon.vue";
import { setLocale } from "@/i18n";
import { FONT_SIZES, THEMES, useSettingsStore } from "@/stores/settings";

const { t } = useI18n();
const settings = useSettingsStore();

function applyLocale(locale: "zh-CN" | "en-US"): void {
  settings.locale = locale;
  setLocale(locale);
  settings.persist();
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-1 text-[13px] font-medium text-foreground">{{ t("settings.appearance.paletteTitle") }}</div>
      <p class="mb-3 text-[11px] text-dim2">{{ t("settings.appearance.paletteHint") }}</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <button
          v-for="theme in THEMES"
          :key="theme.value"
          type="button"
          class="flex cursor-pointer flex-col gap-2 rounded-[10px] border px-3 py-3 text-left transition-colors"
          :class="settings.theme === theme.value ? 'border-accent bg-panel-2' : 'border-line hover:bg-panel-2'"
          :aria-pressed="settings.theme === theme.value"
          :data-testid="`theme-${theme.value}`"
          @click="settings.setTheme(theme.value)"
        >
          <span class="flex gap-1" aria-hidden="true">
            <span
              v-for="color in theme.colors"
              :key="color"
              class="size-4 rounded-full border border-black/10"
              :style="{ backgroundColor: color }"
            />
          </span>
          <span>
            <span class="block text-[12px] font-medium text-foreground">{{ theme.label }}</span>
            <span class="block text-[10.5px] leading-snug text-dim2">{{ t(theme.description) }}</span>
          </span>
        </button>
      </div>
    </div>
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-3 text-[13px] font-medium text-foreground">{{ t("settings.colorMode.title") }}</div>
      <div class="grid grid-cols-3 gap-2">
        <button
          v-for="mode in ['dark', 'light', 'system'] as const"
          :key="mode"
          type="button"
          class="flex cursor-pointer flex-col items-center gap-2 rounded-[10px] border px-3 py-3 transition-colors"
          :class="settings.colorMode === mode ? 'border-accent bg-panel-2' : 'border-line hover:bg-panel-2'"
          :aria-pressed="settings.colorMode === mode"
          :data-testid="`color-mode-${mode}`"
          @click="settings.setColorMode(mode)"
        >
          <Icon :name="mode === 'dark' ? 'moon' : mode === 'light' ? 'sun' : 'refresh'" :size="16" class="text-dim" />
          <span class="text-[12px] text-foreground">{{ t(`settings.colorMode.${mode}`) }}</span>
        </button>
      </div>
    </div>
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-1 text-[13px] font-medium text-foreground">{{ t("settings.appearance.fontSizeTitle") }}</div>
      <p class="mb-3 text-[11px] text-dim2">{{ t("settings.appearance.fontSizeHint") }}</p>
      <div class="grid grid-cols-3 gap-2">
        <button
          v-for="option in FONT_SIZES"
          :key="option.value"
          type="button"
          class="flex cursor-pointer items-baseline justify-center gap-2 rounded-[10px] border px-3 py-2.5 transition-colors"
          :class="settings.fontSize === option.value ? 'border-accent bg-panel-2 text-foreground' : 'border-line text-dim hover:bg-panel-2'"
          :aria-pressed="settings.fontSize === option.value"
          :data-testid="`font-size-${option.value}`"
          @click="settings.setFontSize(option.value)"
        >
          <span aria-hidden="true" :style="{ fontSize: `${13 * option.scale}px` }">Aa</span>
          <span class="text-[11px]">{{ t(option.label) }}</span>
        </button>
      </div>
    </div>
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-3 text-[13px] font-medium text-foreground">{{ t("settings.language.label") }}</div>
      <div class="flex gap-2">
        <button
          v-for="locale in ['zh-CN', 'en-US'] as const"
          :key="locale"
          class="flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-line px-3 py-1.5 text-[12px] transition-colors"
          :class="settings.locale === locale ? 'bg-panel-2 text-foreground' : 'text-dim hover:bg-panel-2'"
          @click="applyLocale(locale)"
        >
          {{ locale === "zh-CN" ? t("settings.language.zhCN") : t("settings.language.enUS") }}
        </button>
      </div>
    </div>
  </div>
</template>
