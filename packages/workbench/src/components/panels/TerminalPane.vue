<script setup lang="ts">
import { ref } from "vue";

const termLines = ref<string[]>(["GreyWork Shell v0.9.2 — 输入 help 查看可用命令"]);
const termInput = ref("");

function pushTerm(lines: string[]): void {
  termLines.value.push(...lines);
}

function runTerm(): void {
  const cmd = termInput.value.trim();
  if (!cmd) return;
  termLines.value.push("greywork ~ % " + cmd);
  const lower = cmd.toLowerCase();
  if (lower === "clear") {
    termLines.value = [];
  } else if (lower === "help") {
    pushTerm(["可用命令：help / ls / git status / pnpm typecheck / pnpm test / clear"]);
  } else if (lower === "ls" || lower === "dir") {
    pushTerm(["apps  packages  docs  package.json  pnpm-workspace.yaml"]);
  } else if (lower.startsWith("git status")) {
    pushTerm(["On branch main", "Changes not staged for commit:", "  modified:   packages/workbench/src/AppShell.vue"]);
  } else if (lower.startsWith("pnpm typecheck")) {
    pushTerm(["> greywork@ typecheck", "✓ 11 packages passed in 6.3s"]);
  } else if (lower.startsWith("pnpm test")) {
    pushTerm(["> vitest run", "Test Files  12 passed (12)", "     Tests  38 passed (38)"]);
  } else {
    pushTerm(["zsh: command not found: " + cmd]);
  }
  termInput.value = "";
}
</script>

<template>
  <div class="side__pane side__pane--term">
    <div class="term">
      <div class="term__lines">
        <p v-for="(line, i) in termLines" :key="i" :class="{ term__cmd: line.startsWith('greywork') }">{{ line }}</p>
      </div>
      <div class="term__input">
        <span>greywork ~ %</span>
        <input v-model="termInput" spellcheck="false" aria-label="终端输入" @keydown.enter="runTerm" />
      </div>
    </div>
  </div>
</template>
