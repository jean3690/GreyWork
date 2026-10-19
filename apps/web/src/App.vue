<script setup lang="ts">
import { AuthGate, Shell } from "@greywork/workbench";
</script>

<template>
  <!-- 与桌面端的 App.vue 是同一层壳，只是没有那套「拖到窗口上开预览」的接线：浏览器里
       File 拿不到磁盘绝对路径，那条 HTML5 drop 路径在这里会静默降级成空转 —— 与其留一条
       永不生效的通路，不如不装（真要给 Web 端加全局拖放，它会需要另一套契约）。 -->
  <AuthGate>
    <Shell />
  </AuthGate>
</template>
