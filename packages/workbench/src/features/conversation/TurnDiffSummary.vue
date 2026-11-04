<script setup lang="ts">
/**
 * 回合改动摘要（Codex 形态）：回答末尾一行「改动了 N 个文件 +X −Y」，展开是文件清单。
 *
 * 数据源是 `message.tools`（不是段落里的 toolCallIds——那是按出现顺序切片的子集）：
 * 一个回合可能有多段工具调用，摘要要的是整条助手消息的并集。
 *
 * 净增删的算法：同一路径多次写入时，用**第一次的 oldText 与最后一次的 newText** 做一次
 * LCS，避免把中间态重复计进 +/−；拿不到 diff 的调用退回 `diffStatOf` 求和（churn）。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolActivity } from "@/types";
import { appEvents } from "@/events";
import { diffStatOf } from "@/lib/tool-activity";
import { diffTexts } from "@/lib/unified-diff";
import Icon from "@/features/shared/Icon.vue";

const props = defineProps<{
  activities: ToolActivity[];
  /** 流式中的回合不显示摘要：数字还在变，先把注意力留给正文。 */
  streaming?: boolean;
}>();

const { t } = useI18n();
const open = ref(false);

interface FileChange {
  path: string;
  name: string;
  dir: string;
  added: number;
  removed: number;
}

/** 路径归一：统一分隔符、去掉开头的 `./`，同一文件的不同写法才能并到一组。 */
function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

const files = computed<FileChange[]>(() => {
  const groups = new Map<string, ToolActivity[]>();
  for (const activity of props.activities) {
    if (activity.kind !== "edit" && activity.kind !== "delete" && activity.kind !== "move") continue;
    if (!activity.path) continue;
    const key = normalize(activity.path);
    const list = groups.get(key);
    if (list) list.push(activity);
    else groups.set(key, [activity]);
  }

  const changes: FileChange[] = [];
  for (const [path, group] of groups) {
    const withDiff = group.filter((activity) => activity.detail?.diff);
    let added = 0;
    let removed = 0;
    if (withDiff.length === group.length && withDiff.length > 0) {
      const first = withDiff[0].detail!.diff!;
      const last = withDiff[withDiff.length - 1].detail!.diff!;
      const stat = diffTexts(first.oldText ?? "", last.newText);
      added = stat.added;
      removed = stat.removed;
    } else {
      for (const activity of group) {
        const stat = diffStatOf(activity);
        if (!stat) continue;
        added += stat.added;
        removed += stat.removed;
      }
    }
    const segments = path.split("/");
    changes.push({
      path,
      name: segments.at(-1) ?? path,
      dir: segments.length > 1 ? segments.slice(0, -1).join("/") : "",
      added,
      removed,
    });
  }
  return changes;
});

const total = computed(() =>
  files.value.reduce((acc, file) => ({ added: acc.added + file.added, removed: acc.removed + file.removed }), { added: 0, removed: 0 }),
);

/** 点文件 → 预览面板（跨面板请求走事件，不直连 preview store）。 */
function openFile(file: FileChange): void {
  appEvents.emit("preview:request", { path: file.path, name: file.name, source: "disk" });
}
</script>

<template>
  <section v-if="!props.streaming && files.length" class="mt-1" data-testid="turn-diff-summary">
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-1.5 px-1 py-1 text-left text-[12px] text-dim2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan [font-family:inherit]"
      :aria-expanded="open"
      :aria-label="t('chat.turnDiff.toggle')"
      @click="open = !open"
    >
      <Icon name="edit" :size="12" class="flex-none text-dim2" />
      <span class="font-medium">{{ t("chat.turnDiff.summary", { count: files.length }, files.length) }}</span>
      <span class="flex flex-none items-center gap-1 font-mono text-[10px] tabular-nums" data-testid="turn-diff-total">
        <span v-if="total.added" class="text-mint">+{{ total.added }}</span>
        <span v-if="total.removed" class="text-orange">-{{ total.removed }}</span>
      </span>
      <Icon :name="open ? 'up' : 'down'" :size="11" class="ml-auto flex-none text-dim2" />
    </button>

    <ul v-if="open" class="m-0 ml-[6px] flex list-none flex-col border-l border-line py-1 pl-3 pr-1">
      <li v-for="file in files" :key="file.path">
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 rounded-[calc(6px*var(--gw-radius-scale))] py-0.5 text-left text-[11.5px] transition-colors hover:bg-panel-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan"
          data-testid="turn-diff-file"
          :aria-label="file.path"
          @click="openFile(file)"
        >
          <span class="shrink-0 truncate font-mono text-foreground">{{ file.name }}</span>
          <span v-if="file.dir" class="min-w-0 flex-1 truncate text-[10.5px] text-dim2">{{ file.dir }}</span>
          <span v-else class="flex-1" />
          <span class="flex flex-none items-center gap-1 font-mono text-[10px] tabular-nums">
            <span v-if="file.added" class="text-mint">+{{ file.added }}</span>
            <span v-if="file.removed" class="text-orange">-{{ file.removed }}</span>
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>
