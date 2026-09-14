<script setup lang="ts">
import { computed } from "vue";
import qrcode from "qrcode-generator";

/**
 * 二维码图（微信扫码登录 / 飞书扫码创建应用共用）。
 *
 * 只把宿主给的一段链接编成 SVG：码里的内容与凭据都在宿主手里，界面不参与。
 */
const props = defineProps<{ content: string }>();

/** 内容变化即重算；`scalable` 让 SVG 跟着容器走（不同 DPI 下都不糊）。 */
const svg = computed(() => {
  const code = qrcode(0, "M");
  code.addData(props.content);
  code.make();
  // 库自带白底矩形：浅色主题下也能扫，容器不必再补背景。
  return code.createSvgTag({ margin: 8, scalable: true });
});
</script>

<template>
  <div class="w-[168px] rounded-[8px] bg-white p-1 [&>svg]:h-auto [&>svg]:w-full" v-html="svg" />
</template>
