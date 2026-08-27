<script setup lang="ts">
import { ref } from "vue";
import { useChatStore } from "../../stores/chat";

const chat = useChatStore();

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
  chat.submitText("[截图投喂] 网页预览截图已附上，共标注 " + webMarkers.value.length + " 处问题，请检查并给出修复方案。");
  webMarkers.value = [];
}
</script>

<template>
  <div class="side__pane">
    <div class="webprev__bar">
      <code>{{ webUrl }}</code>
      <button class="btn btn--mini" :class="{ 'btn--on': annotateMode }" @click="annotateMode = !annotateMode">
        {{ annotateMode ? "标注中" : "标注模式" }}
      </button>
      <button class="btn btn--mini" @click="clearMarkers">清除</button>
      <button class="btn btn--mini btn--primary" @click="feedScreenshot">截图投喂</button>
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
    <p class="footnote">点击元素标记界面问题，「截图投喂」会把标注截图发进当前对话。</p>
  </div>
</template>
