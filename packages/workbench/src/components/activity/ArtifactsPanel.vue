<script setup lang="ts">
/**
 * 底部活动面板「产物」页签内容（core.artifacts 贡献，activity.artifacts）。
 *
 * 数据源是 artifact store 的全局产物列表（newest-first，deliverArtifact 里 unshift），
 * 跨会话汇总。点击名称在右栏预览面板就地打开 —— 主路径与 ArtifactCards 一致；
 * 无 VFS 路径的产物（仅登记未落盘的）按钮禁用，理由与卡片面相同。
 * 空态只占位说明，不塞示例数据（产物只应来自真实运行，见 artifact store 注释）。
 */
import { useArtifactStore } from "../../stores/artifact";
import { usePreviewStore } from "../../stores/preview";
import Icon from "../Icon.vue";

const artifactStore = useArtifactStore();
const preview = usePreviewStore();

/**
 * 在右栏打开产物，并把落盘路径一并挂到 tab 上（预览的「用系统应用打开」据此定位）。
 * 不能塞进 `open` 的参数里：命中已打开的路径时它会早退，新参数带不进去。
 */
function openPreview(path: string | undefined, name: string, diskPath: string | undefined): void {
  if (!path) return;
  preview.open(path, name);
  if (diskPath) preview.attachDiskPath(path, diskPath);
}
</script>

<template>
  <div v-if="artifactStore.artifacts.length" data-testid="artifacts-panel" class="h-full overflow-y-auto px-3 py-2">
    <ul class="flex flex-col gap-0.5">
      <li
        v-for="artifact in artifactStore.artifacts"
        :key="artifact.id"
        data-testid="band-artifact"
        class="flex h-[30px] shrink-0 items-center gap-2 rounded-[8px] px-2 transition-colors hover:bg-panel"
      >
        <Icon name="folder" :size="13" class="shrink-0 text-dim2" />
        <button
          type="button"
          data-testid="band-artifact-name"
          :disabled="!artifact.path"
          :title="artifact.path ? `在预览面板打开 ${artifact.path}` : '该产物没有 VFS 路径，无法预览'"
          class="min-w-0 flex-1 cursor-pointer truncate text-start text-[12.5px] text-foreground transition-colors hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-default disabled:hover:text-foreground"
          @click="openPreview(artifact.path, artifact.name, artifact.diskPath)"
        >
          {{ artifact.name }}
        </button>
        <span class="shrink-0 text-[10.5px] text-dim2">{{ artifact.meta }}</span>
      </li>
    </ul>
  </div>
  <div v-else data-testid="artifacts-panel-empty" class="flex h-full flex-col items-center justify-center gap-0.5 px-4 text-center">
    <span class="text-[12px] text-dim2">还没有全局产物</span>
    <span class="text-[11px] text-dim2">会话中生成的产物会出现在这里</span>
  </div>
</template>
