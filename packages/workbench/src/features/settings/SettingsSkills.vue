<script setup lang="ts">
/**
 * 设置页「技能」面板：自定义市场源 + 已安装（工作区 .agents/skills 磁盘扫描）+
 * 发现（跨所有启用源搜索）。
 *
 * 安装目标 .agents/skills/&lt;skillId&gt;/ 是外部 ACP agent（opencode /
 * claude-code / codex 等）的原生技能目录——装完新建/重启 agent 会话即被识别，
 * 宿主不注入会话上下文。
 */
import { onMounted, ref } from "vue";
import type { MarketSkillEntry } from "@greywork/plugins";
import { useSkillsStore, type InstalledSkill } from "@/stores/skills";
import { useSettingsStore, type SkillSourceEntry } from "@/stores/settings";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";
import SkillSourceFormDialog from "@/features/settings/SkillSourceFormDialog.vue";

const skills = useSkillsStore();
const settings = useSettingsStore();

const searchQuery = ref("");
const searchError = ref("");
const actionError = ref("");
/** 二次确认对象：卸载某已装技能 / 从市场安装（已装则提示覆盖更新）/ 按记录更新。 */
const confirm = ref<
  | null
  | { kind: "install"; entry: MarketSkillEntry }
  | { kind: "update"; skill: InstalledSkill }
  | { kind: "uninstall"; skill: InstalledSkill }
>(null);

let timer: ReturnType<typeof setTimeout> | null = null;

onMounted(() => {
  void skills.refreshInstalled();
});

function onSearchInput(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runSearch(), 400);
}

async function runSearch(): Promise<void> {
  searchError.value = "";
  try {
    await skills.searchDiscover(searchQuery.value);
  } catch (error) {
    searchError.value = String(error);
  }
}

async function performInstall(): Promise<void> {
  if (!confirm.value || confirm.value.kind !== "install") return;
  const { entry } = confirm.value;
  confirm.value = null;
  actionError.value = "";
  try {
    await skills.installFromMarket(entry);
  } catch (error) {
    actionError.value = String(error);
  }
}

async function performUpdate(): Promise<void> {
  if (!confirm.value || confirm.value.kind !== "update") return;
  const { skill } = confirm.value;
  confirm.value = null;
  actionError.value = "";
  try {
    await skills.updateInstalled(skill.id);
  } catch (error) {
    actionError.value = String(error);
  }
}

async function performUninstall(): Promise<void> {
  if (!confirm.value || confirm.value.kind !== "uninstall") return;
  const { skill } = confirm.value;
  confirm.value = null;
  actionError.value = "";
  try {
    await skills.uninstallSkill(skill.id);
  } catch (error) {
    actionError.value = String(error);
  }
}

function installedOf(entry: MarketSkillEntry): InstalledSkill | undefined {
  return skills.installed.find((skill) => skill.id === entry.skillId);
}

// ---------- 自定义源管理 ----------
const sourceFormOpen = ref(false);
const sourceEditEntry = ref<SkillSourceEntry | null>(null);
const resetSourceTarget = ref(false);

const existingSourceLabels = settings.skillSources.map((s) => s.label);

function openAddSource(): void {
  sourceEditEntry.value = null;
  sourceFormOpen.value = true;
}

function openEditSource(entry: SkillSourceEntry): void {
  sourceEditEntry.value = entry;
  sourceFormOpen.value = true;
}

function onSourceSave(payload: SkillSourceEntry): void {
  settings.upsertSkillSource(payload);
  sourceFormOpen.value = false;
  sourceEditEntry.value = null;
}

function confirmResetSources(): void {
  settings.resetSkillSources();
  resetSourceTarget.value = false;
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-1 flex items-center justify-between gap-2">
        <span class="text-[13px] font-medium text-foreground">市场源</span>
        <span class="flex gap-1.5">
          <button
            type="button"
            class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
            @click="openAddSource"
          >
            ＋ 添加源
          </button>
          <button
            type="button"
            class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-destructive"
            @click="resetSourceTarget = true"
          >
            恢复默认
          </button>
        </span>
      </div>
      <p class="mb-3 text-[11px] leading-relaxed text-dim2">
        技能搜索与安装的来源。内置 skills.sh 无法删除；自定义 API 端点需兼容 skills.sh
        协议（<code>/api/search</code>、<code>/api/download</code>）。
      </p>
      <div class="flex flex-col gap-1.5">
        <div v-for="entry in settings.skillSources" :key="entry.id" class="flex items-center gap-2 rounded-[10px] bg-panel-2 px-2.5 py-2">
          <span class="min-w-0 flex-1 text-[12px] text-foreground">{{ entry.label }}</span>
          <span class="shrink-0 rounded-full border border-line px-1.5 py-px font-mono text-[10px] text-dim2">
            {{ entry.type === "api" ? "API" : "GitHub" }}
          </span>
          <span class="shrink-0 max-w-[140px] truncate font-mono text-[10px] text-dim2">
            {{ entry.type === "api" ? entry.url : entry.repo }}
          </span>
          <label class="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-dim">
            <input
              type="checkbox"
              class="size-4 cursor-pointer accent-[var(--accent)]"
              :checked="entry.enabled"
              :aria-label="`启用 ${entry.label}`"
              @change="settings.setSkillSourceEnabled(entry.id, ($event.target as HTMLInputElement).checked)"
            />
          </label>
          <button
            type="button"
            class="shrink-0 rounded-[8px] border border-line px-2 py-1 text-[11px] text-dim transition-colors hover:text-foreground"
            @click="openEditSource(entry)"
          >
            编辑
          </button>
          <button
            type="button"
            class="shrink-0 rounded-[8px] border border-line px-2 py-1 text-[11px] text-dim transition-colors hover:text-destructive"
            @click="settings.removeSkillSource(entry.id)"
          >
            删除
          </button>
        </div>
      </div>
    </div>

    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-1 flex items-center justify-between gap-2">
        <span class="text-[13px] font-medium text-foreground">已安装</span>
        <button
          type="button"
          class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground disabled:opacity-50"
          :disabled="skills.installedLoading"
          @click="skills.refreshInstalled()"
        >
          {{ skills.installedLoading ? "扫描中…" : "刷新" }}
        </button>
      </div>
      <p class="mb-3 text-[11px] leading-relaxed text-dim2">
        扫描工作区 <b>{{ skills.workspace?.dir ?? ".agents/skills" }}</b> 的磁盘源（外部 agent 手动放入的技能也会出现）。
        <template v-if="skills.workspace && !skills.workspace.root.bound">当前未绑定工作区，回落设置项 / 应用私有目录。</template>
        <template v-else-if="skills.workspace?.root.bound">已绑定当前工作区。</template>
        <template v-if="!skills.hostAvailable">浏览器预览态只读：安装/卸载需要桌面版（Tauri）。</template>
      </p>

      <p v-if="skills.installedError" class="mb-2 text-[11px] text-destructive">{{ skills.installedError }}</p>
      <p v-if="skills.installed.length === 0" class="text-[12px] text-dim2">
        {{ skills.installedLoading ? "扫描中…" : "还没有安装任何技能。" }}
      </p>
      <div v-else class="flex flex-col gap-2">
        <div v-for="skill in skills.installed" :key="skill.id" class="rounded-[10px] bg-panel-2 p-2.5">
          <div class="flex items-center gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate text-[12px] font-medium text-foreground">{{ skill.name }}</span>
                <span class="shrink-0 rounded-full border border-line px-1.5 py-px font-mono text-[10px] text-dim2">{{ skill.id }}</span>
                <span
                  v-if="skills.recordBySkillId.get(skill.id)"
                  class="shrink-0 rounded-full border border-line px-1.5 py-px text-[10px] text-dim2"
                  >经市场安装</span
                >
              </div>
              <p v-if="skill.description" class="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-dim2">{{ skill.description }}</p>
              <p class="mt-1 truncate font-mono text-[10px] text-dim2">{{ skill.dir }}</p>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <button
                v-if="skills.recordBySkillId.get(skill.id)"
                type="button"
                class="rounded-[8px] border border-line px-2 py-1 text-[11px] text-dim transition-colors hover:text-foreground disabled:opacity-50"
                :disabled="skills.busyId === skill.id"
                @click="confirm = { kind: 'update', skill }"
              >
                更新
              </button>
              <button
                type="button"
                class="rounded-[8px] border border-line px-2 py-1 text-[11px] text-dim transition-colors hover:text-destructive disabled:opacity-50"
                :disabled="!skills.hostAvailable || skills.busyId === skill.id"
                @click="confirm = { kind: 'uninstall', skill }"
              >
                卸载
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-1 text-[13px] font-medium text-foreground">发现</div>
      <p class="mb-3 text-[11px] leading-relaxed text-dim2">
        跨所有已启用源并行搜索（默认 skills.sh；上方自定义源）。已装技能目录里出现的技能会标「已安装」。
      </p>
      <div class="mb-2 flex items-center gap-2">
        <input
          v-model="searchQuery"
          class="min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
          placeholder="搜索技能名 / 关键字，如 tdd、review…"
          @input="onSearchInput"
          @keydown.enter.prevent="runSearch"
        />
        <button
          type="button"
          class="rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 text-[11px] text-dim transition-colors hover:text-foreground disabled:opacity-50"
          :disabled="skills.searching"
          @click="runSearch"
        >
          {{ skills.searching ? "搜索中…" : "搜索" }}
        </button>
      </div>

      <p v-if="searchError" class="mb-2 text-[11px] text-destructive">{{ searchError }}</p>
      <p v-if="!skills.searching && skills.discoverResults.length === 0 && searchQuery.trim() !== ''" class="text-[12px] text-dim2">
        没有匹配的技能。
      </p>

      <div v-if="skills.discoverResults.length > 0" class="flex flex-col gap-2">
        <div v-for="entry in skills.discoverResults" :key="entry.ref" class="rounded-[10px] bg-panel-2 p-2.5">
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate text-[12px] font-medium text-foreground">{{ entry.name }}</span>
                <span class="shrink-0 max-w-[40%] truncate rounded-full border border-line px-1.5 py-px font-mono text-[10px] text-dim2">{{
                  entry.source
                }}</span>
                <span class="shrink-0 rounded-full border border-line px-1.5 py-px text-[10px] text-dim2">安装 {{ entry.installs }}</span>
                <span v-if="installedOf(entry)" class="shrink-0 rounded-full border border-line px-1.5 py-px text-[10px] text-accent"
                  >已安装</span
                >
              </div>
              <p class="mt-0.5 truncate font-mono text-[10px] text-dim2">{{ entry.ref }}</p>
            </div>
            <button
              type="button"
              class="shrink-0 rounded-[8px] border border-line px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="!entry.downloadable || !skills.hostAvailable || skills.busyId !== null"
              @click="confirm = { kind: 'install', entry }"
            >
              {{ installedOf(entry) ? "更新" : "安装" }}
            </button>
          </div>
        </div>
      </div>

      <p v-if="actionError" class="mt-2 text-[11px] text-destructive">{{ actionError }}</p>
      <p v-if="skills.busyId" class="mt-2 text-[11px] text-dim2">正在处理 {{ skills.busyId }}…</p>
    </div>

    <ConfirmDialog
      v-if="confirm?.kind === 'install'"
      title="安装技能？"
      :message="`将下载「${confirm.entry.name}」并写入 ${skills.workspace?.root.dir ?? '工作区'}/.agents/skills/${confirm.entry.skillId}/。${installedOf(confirm.entry) ? '该技能已安装，本次将覆盖为市场最新版本。' : ''}新建 / 重启 agent 会话后生效。`"
      confirm-label="安装"
      @confirm="performInstall"
      @cancel="confirm = null"
    />

    <ConfirmDialog
      v-if="confirm?.kind === 'update'"
      :title="`更新「${confirm.skill.name}」？`"
      :message="`将从市场重新下载并覆盖 ${confirm.skill.dir}。新建 / 重启 agent 会话后生效。`"
      confirm-label="更新"
      @confirm="performUpdate"
      @cancel="confirm = null"
    />

    <ConfirmDialog
      v-if="confirm?.kind === 'uninstall'"
      :title="`卸载「${confirm.skill.name}」？`"
      :message="`将删除 ${confirm.skill.dir} 整个目录。已在跑的 agent 会话不受影响。`"
      confirm-label="卸载"
      @confirm="performUninstall"
      @cancel="confirm = null"
    />

    <SkillSourceFormDialog
      :open="sourceFormOpen"
      :entry="sourceEditEntry"
      :existing-labels="existingSourceLabels"
      @save="onSourceSave"
      @cancel="
        sourceFormOpen = false;
        sourceEditEntry = null;
      "
    />

    <ConfirmDialog
      v-if="resetSourceTarget"
      title="恢复默认技能源？"
      message="将移除所有自定义源，仅保留内置 skills.sh。此操作不可撤销。"
      confirm-label="恢复默认"
      @confirm="confirmResetSources"
      @cancel="resetSourceTarget = false"
    />
  </div>
</template>
