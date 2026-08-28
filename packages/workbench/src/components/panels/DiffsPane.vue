<script setup lang="ts">
import { computed, ref } from "vue";
import { Check, GitCommitHorizontal, GitPullRequestArrow, Rocket } from "lucide-vue-next";
import { statusLetter, useVfsStore, workspaceGit } from "../../stores/vfs";
import { useI18n } from "vue-i18n";

const vfs = useVfsStore();
const { t } = useI18n();
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
      {{ t("panels.diffs.summary", { files: totals.files }) }}
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
      <p v-if="!groups.length" class="footnote">{{ t("panels.diffs.empty") }}</p>
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
        <button
          class="btn btn--primary btn--mini"
          :disabled="!message.trim() || committed"
          :title="t('panels.diffs.commitTitle')"
          @click="commit"
        >
          <GitCommitHorizontal class="size-3.5" />Commit
        </button>
      </div>
      <div class="diff-actions__row">
        <button class="btn btn--mini" disabled :title="t('panels.diffs.remoteBackendNeeded')"><Rocket class="size-3.5" />Push</button>
        <button class="btn btn--mini" disabled :title="t('panels.diffs.remoteBackendNeeded')">
          <GitPullRequestArrow class="size-3.5" />Create PR
        </button>
        <span v-if="committed" class="diff-actions__ok"><Check class="size-3" />{{ t("panels.diffs.committed") }}</span>
        <span v-if="commitError" class="diff-actions__err">{{ commitError }}</span>
      </div>
    </div>
  </div>
</template>
