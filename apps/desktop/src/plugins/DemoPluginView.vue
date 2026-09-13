<script setup lang="ts">
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <main class="mx-auto flex h-full w-full max-w-[760px] flex-col gap-4 overflow-y-auto p-6" data-testid="demo-plugin-view">
    <header>
      <p class="text-[11px] font-medium uppercase tracking-[0.14em] text-cyan">Third-party plugin</p>
      <h1 class="mt-1 text-[22px] font-semibold text-foreground">Demo 插件已运行</h1>
      <p class="mt-2 max-w-[560px] text-[13px] leading-6 text-dim">
        这个页面来自桌面宿主，通过 registerPlugin() 注入；工作台本身没有硬编码它的路由或组件。
      </p>
    </header>

    <section class="rounded-[12px] border border-line-2 bg-panel-2 p-4">
      <p class="text-[12px] text-dim2">插件局部状态</p>
      <div class="mt-3 flex items-center gap-3">
        <button
          type="button"
          class="h-8 cursor-pointer rounded-[8px] bg-accent px-3 text-[12px] font-medium text-accent-ink transition-opacity hover:opacity-90"
          data-testid="demo-plugin-increment"
          @click="count += 1"
        >
          点击计数
        </button>
        <output class="font-mono text-[13px] text-foreground" data-testid="demo-plugin-count">{{ count }}</output>
      </div>
    </section>
  </main>
</template>
