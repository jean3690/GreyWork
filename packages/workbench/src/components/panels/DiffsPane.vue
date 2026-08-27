<script setup lang="ts">
import { computed, ref } from "vue";
import { Check, GitCommitHorizontal, GitPullRequestArrow, Rocket } from "lucide-vue-next";
import { statusLetter, useVfsStore, workspaceGit } from "../../stores/vfs";

const vfs = useVfsStore();
const message = ref("");
const committed = ref(false);
const commitError = ref("");

/** 变更按目录分组（虚拟文件系统相对 git 基线）。 */
const groups = computed(() => {
  const byDir = new Map<string, Array<{ file: string; letter: string; add: number; del: number }>>();
  for (const change of vfs.changes) {
    const slash = change.path.lastIndexOf("/");
    const dir = slash === -1 ? "/" : change.path.slice(0, slash);
    const file = slash === -1 ? change.path : change.path.slice(slash + 1);
    const list = byDir.get(dir) ?? [];
    list.push({ file, letter: statusLetter(change.status), add: change.add, del: change.del });
    byDir.set(dir, list);
  }
  return Array.from(byDir.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, children]) => ({ path, children }));
});

const totals = computed(() =>
  vfs.changes.reduce((acc, change) => ({ files: acc.files + 1, add: acc.add + change.add, del: acc.del + change.del }), {
    files: 0,
    add: 0,
    del: 0,
  }),
);

async function commit(): Promise<void> {
  const text = message.value.trim();
  if (!text || committed.value) return;
  commitError.value = "";
  try {
    await workspaceGit.commit(text);
    committed.value = true;
    await vfs.refreshStatus();
  } catch (error) {
    commitError.value = error instanceof Error ? error.message : String(error);
  }
}
</script>

<template>
  <div class="side__pane">
    <p class="side__cap">
      本次变更 · {{ totals.files }} 个文件
      <b class="diff-add">+{{ totals.add }}</b>
      <b class="diff-del">−{{ totals.del }}</b>
    </p>
    <div class="diff-tree">
      <div v-for="node in groups" :key="node.path" class="diff-dir">
        <p class="diff-dir__name">▸ {{ node.path === "/" ? "." : node.path }}/</p>
        <div v-for="f in node.children" :key="f.file" class="diff-file">
          <span class="diff-file__status" :data-status="f.letter">{{ f.letter }}</span>
          <span class="diff-file__name">{{ f.file }}</span>
          <span class="diff-file__stat"
            ><b class="diff-add">+{{ f.add }}</b
            ><b class="diff-del">−{{ f.del }}</b></span
          >
        </div>
      </div>
      <p v-if="!groups.length" class="footnote">暂无 Diff。运行一次任务后，变更会写入虚拟文件系统并在这里展示。</p>
    </div>
    <div class="diff-actions">
      <div class="diff-actions__row">
        <input
          v-model="message"
          class="diff-actions__msg"
          placeholder="Commit message (current branch)"
          aria-label="Commit message"
          :disabled="committed"
          @keydown.enter="commit"
        />
        <button class="btn btn--primary btn--mini" :disabled="!message.trim() || committed" title="提交到当前分支" @click="commit">
          <GitCommitHorizontal class="size-3.5" />Commit
        </button>
      </div>
      <div class="diff-actions__row">
        <button class="btn btn--mini" disabled title="需远程后端（未接入）"><Rocket class="size-3.5" />Push</button>
        <button class="btn btn--mini" disabled title="需远程后端（未接入）"><GitPullRequestArrow class="size-3.5" />Create PR</button>
        <span v-if="committed" class="diff-actions__ok"><Check class="size-3" />已提交</span>
        <span v-if="commitError" class="diff-actions__err">{{ commitError }}</span>
      </div>
    </div>
  </div>
</template>
