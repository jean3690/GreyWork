<script setup lang="ts">
import { ref } from "vue";
import { useChatStore } from "../../stores/chat";
import { useI18n } from "vue-i18n";

const chat = useChatStore();
const { t } = useI18n();

const webUrl = ref("http://localhost:5173/workspace");
const annotateMode = ref(false);
const webMarkers = ref<{ x: number; y: number }[]>([]);

function markSpot(event: MouseEvent): void {
  if (!annotateMode.value) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  webMarkers.value.push({ x: event.clientX - rect.left, y: event.clientY - rect.top });
}

function clearMarkers(): void {
  webMarkers.value = [];
  annotateMode.value = false;
}

function feedScreenshot(): void {
  chat.submitText(t("panels.preview.feedText", { count: webMarkers.value.length }));
  webMarkers.value = [];
}
</script>

<template>
  <div class="side__pane">
    <div class="webprev__bar">
      <code>{{ webUrl }}</code>
      <button class="btn btn--mini" :class="{ 'btn--on': annotateMode }" @click="annotateMode = !annotateMode">
        {{ annotateMode ? t("panels.preview.annotating") : t("panels.preview.annotateMode") }}
      </button>
      <button class="btn btn--mini" @click="clearMarkers">{{ t("panels.preview.clear") }}</button>
      <button class="btn btn--mini btn--primary" @click="feedScreenshot">{{ t("panels.preview.feed") }}</button>
    </div>
    <div class="webprev" :data-annotate="annotateMode" @click="markSpot">
      <div class="webprev__nav"><i></i><i></i><i></i><span class="webprev__pill"></span></div>
      <div class="webprev__hero"></div>
      <div class="webprev__row">
        <div class="webprev__card"></div>
        <div class="webprev__card"></div>
        <div class="webprev__card"></div>
      </div>
      <span v-for="(mk, i) in webMarkers" :key="i" class="webprev__marker" :style="{ left: mk.x + 'px', top: mk.y + 'px' }">{{
        i + 1
      }}</span>
    </div>
    <p class="footnote">{{ t("panels.preview.hint", { feed: t("panels.preview.feed") }) }}</p>
  </div>
</template>
