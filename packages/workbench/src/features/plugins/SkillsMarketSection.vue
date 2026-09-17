<script setup lang="ts">
/**
 * 插件市场 · 技能专区：搜索 skills.sh 并把技能装进工作区 `.agents/skills/`。
 *
 * 数据面完全交给 `useSkillsStore`（已安装 = 磁盘扫描、发现 = 跨启用源搜索、
 * 安装/更新/卸载 = 宿主写盘）——设置 → 技能 与这里共用同一份 store，
 * 不重复实现任何安装流程，也就不会有第二条会漂移的写入路径。
 */
import { onMounted, ref } from "vue";
import { i18n } from "@/i18n";
import { useSkillsStore, type InstalledSkill } from "@/stores/skills";
import Icon from "@/features/shared/Icon.vue";
import { Skeleton } from "@/components/ui/skeleton";

const t = i18n.global.t;
const skills = useSkillsStore();

const query = ref("");
const actionError = ref("");
/** 二次确认对象：安装 / 更新(市场) / 更新(已装记录) / 卸载。 */
const confirm = ref<
  | null
  | { kind: "install"; ref: string; skillId: string; name: string; downloadable: boolean }
  | { kind: "update"; skill: InstalledSkill }
  | { kind: "uninstall"; skill: InstalledSkill }
>(null);

let timer: ReturnType<typeof setTimeout> | null = null;

onMounted(() => {
  void skills.refreshInstalled();
});

function onQueryInput(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runSearch(), 400);
}

async function runSearch(): Promise<void> {
  actionError.value = "";
  try {
    await skills.searchDiscover(query.value);
  } catch (error) {
    actionError.value = String(error);
  }
}

/** 已安装判定：磁盘扫描结果里出现同名 skillId。 */
function installedOf(skillId: string): InstalledSkill | undefined {
  return skills.installed.find((skill) => skill.id === skillId);
}

async function performInstall(): Promise<void> {
  if (!confirm.value || confirm.value.kind !== "install") return;
  const { ref: entryRef, skillId, name, downloadable } = confirm.value;
  confirm.value = null;
  actionError.value = "";
  try {
    await skills.installFromMarket({ ref: entryRef, skillId, name, installs: 0, source: "", downloadable });
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
</script>

<template>
  <div data-testid="market-skills-section">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div class="relative min-w-0 flex-1">
        <Icon name="search" :size="13" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim2" />
        <input
          v-model="query"
          type="search"
          class="h-10 w-full rounded-[10px] border border-line bg-panel pl-9 pr-3 text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
          :placeholder="t('market.skillsSearchPlaceholder')"
          data-testid="market-skills-search"
          @input="onQueryInput"
          @keydown.enter.prevent="runSearch"
        />
      </div>
      <button
        type="button"
        class="h-10 shrink-0 cursor-pointer rounded-[10px] border border-line bg-panel px-3 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground disabled:opacity-50"
        :disabled="skills.installedLoading"
        data-testid="market-skills-refresh"
        @click="skills.refreshInstalled()"
      >
        {{ skills.installedLoading ? t("market.skillsScanning") : t("market.skillsRefresh") }}
      </button>
    </div>

    <p class="mt-2 text-[10.5px] leading-relaxed text-dim2">
      {{ t("market.skillsInstallHint") }}
      <span class="font-mono">{{ skills.workspace?.dir ?? ".agents/skills" }}</span>
    </p>

    <p v-if="actionError" class="mt-3 rounded-[10px] border border-orange/30 bg-orange/10 px-3 py-2 text-[11.5px] text-orange" role="alert">
      {{ actionError }}
    </p>

    <!-- 已安装 -->
    <div class="mt-4">
      <div class="mb-2 flex items-end justify-between gap-3">
        <h2 class="text-[13px] font-semibold text-foreground">{{ t("market.skillsInstalled") }}</h2>
        <span class="font-mono text-[10px] text-dim2">{{ skills.installed.length }}</span>
      </div>
      <p
        v-if="skills.installed.length === 0"
        class="rounded-[12px] border border-dashed border-line-2 bg-panel/50 px-4 py-6 text-center text-[11.5px] text-dim2"
      >
        {{ skills.installedLoading ? t("market.skillsScanning") : t("market.skillsNoneInstalled") }}
      </p>
      <div v-else class="flex flex-col gap-2">
        <article
          v-for="skill in skills.installed"
          :key="skill.id"
          class="rounded-[12px] border border-line bg-panel px-3.5 py-3 transition-colors hover:border-line-2"
          :data-testid="`market-skill-installed-${skill.id}`"
        >
          <div class="flex items-start gap-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-[10px] border border-line bg-panel-2 text-dim">
              <Icon name="lightning" :size="15" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="truncate text-[12.5px] font-medium text-foreground">{{ skill.name }}</span>
                <code class="rounded-[5px] bg-panel-2 px-1.5 py-0.5 text-[9.5px] text-dim2">{{ skill.id }}</code>
                <span
                  v-if="skills.recordBySkillId.get(skill.id)"
                  class="rounded-full border border-accent/25 px-1.5 py-0.5 text-[9px] text-accent"
                >
                  {{ t("market.skillsFromMarket") }}
                </span>
              </div>
              <p v-if="skill.description" class="mt-1 line-clamp-2 text-[11px] leading-relaxed text-dim">{{ skill.description }}</p>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <button
                v-if="skills.recordBySkillId.get(skill.id)"
                type="button"
                class="h-7 cursor-pointer rounded-[7px] border border-line px-2.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground disabled:opacity-40"
                :disabled="skills.busyId === skill.id"
                :data-testid="`market-skill-update-${skill.id}`"
                @click="confirm = { kind: 'update', skill }"
              >
                {{ t("market.skillsUpdate") }}
              </button>
              <button
                type="button"
                class="h-7 cursor-pointer rounded-[7px] border border-line px-2.5 text-[11px] text-dim transition-colors hover:border-orange/40 hover:text-orange disabled:opacity-40"
                :disabled="!skills.hostAvailable || skills.busyId === skill.id"
                :data-testid="`market-skill-uninstall-${skill.id}`"
                @click="confirm = { kind: 'uninstall', skill }"
              >
                {{ t("market.uninstall") }}
              </button>
            </div>
          </div>
        </article>
      </div>
    </div>

    <!-- 发现 -->
    <div class="mt-5">
      <div class="mb-2 flex items-end justify-between gap-3">
        <h2 class="text-[13px] font-semibold text-foreground">{{ t("market.skillsDiscover") }}</h2>
        <span class="font-mono text-[10px] text-dim2">{{ skills.discoverResults.length }}</span>
      </div>

      <div v-if="skills.searching && skills.discoverResults.length === 0" class="grid gap-3 md:grid-cols-2">
        <Skeleton v-for="index in 4" :key="index" class="h-28 rounded-[14px] border border-line bg-panel" />
      </div>

      <div v-else-if="skills.discoverResults.length" class="grid gap-3 md:grid-cols-2">
        <article
          v-for="entry in skills.discoverResults"
          :key="entry.ref"
          class="flex min-h-28 flex-col rounded-[14px] border border-line bg-panel p-4 transition-colors hover:border-line-2"
          :data-testid="`market-skill-${entry.skillId}`"
        >
          <div class="flex items-start gap-3">
            <span class="grid size-10 shrink-0 place-items-center rounded-[11px] border border-line bg-panel-2 text-dim">
              <Icon name="lightning" :size="16" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <h3 class="truncate text-[13px] font-semibold text-foreground">{{ entry.name }}</h3>
                <span
                  v-if="installedOf(entry.skillId)"
                  class="shrink-0 rounded-full bg-mint/10 px-1.5 py-0.5 text-[9.5px] font-medium text-mint"
                >
                  {{ t("market.installed") }}
                </span>
              </div>
              <p class="mt-0.5 truncate font-mono text-[9.5px] text-dim2">{{ entry.ref }}</p>
            </div>
          </div>

          <footer class="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
            <span class="truncate text-[10.5px] text-dim2">
              {{ entry.source || t("market.communityAuthor") }} · {{ t("market.skillsInstalls", { count: entry.installs }) }}
            </span>
            <button
              type="button"
              class="h-7 shrink-0 cursor-pointer rounded-[7px] bg-accent px-3 text-[11px] font-medium text-accent-ink transition-colors hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="!entry.downloadable || !skills.hostAvailable || skills.busyId !== null"
              :data-testid="`market-skill-install-${entry.skillId}`"
              @click="
                confirm = {
                  kind: 'install',
                  ref: entry.ref,
                  skillId: entry.skillId,
                  name: entry.name,
                  downloadable: entry.downloadable,
                }
              "
            >
              {{ skills.busyId === entry.skillId ? t("market.installing") : t("market.install") }}
            </button>
          </footer>
        </article>
      </div>

      <div
        v-else-if="query.trim() !== '' && !skills.searching"
        class="grid min-h-40 place-items-center rounded-[14px] border border-dashed border-line-2 bg-panel/50 px-6 text-center"
      >
        <p class="text-[12px] font-medium text-foreground">{{ t("market.skillsNoResults") }}</p>
      </div>

      <p v-if="!skills.hostAvailable" class="mt-3 text-center text-[10.5px] text-dim2">{{ t("market.skillsDesktopOnly") }}</p>
      <p class="mt-3 text-[10.5px] leading-relaxed text-dim2">{{ t("market.skillsSourcesHint") }}</p>
    </div>

    <!-- 二次确认：安装 / 更新 / 卸载 -->
    <div
      v-if="confirm"
      class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-amber/40 bg-amber/10 px-3.5 py-2.5"
      data-testid="market-skills-confirm"
    >
      <span class="text-[11.5px] text-amber">
        {{
          confirm.kind === "install"
            ? t("market.skillsConfirmInstall", { name: confirm.name })
            : confirm.kind === "update"
              ? t("market.skillsConfirmUpdate", { name: confirm.skill.name })
              : t("market.skillsConfirmUninstall", { name: confirm.skill.name })
        }}
      </span>
      <span class="flex gap-1.5">
        <button
          type="button"
          class="h-7 cursor-pointer rounded-[7px] bg-amber px-2.5 text-[11px] font-medium text-amber-ink transition-opacity hover:opacity-90"
          data-testid="market-skills-confirm-yes"
          @click="
            confirm.kind === 'install' ? void performInstall() : confirm.kind === 'update' ? void performUpdate() : void performUninstall()
          "
        >
          {{ t("market.confirmInstall") }}
        </button>
        <button
          type="button"
          class="h-7 cursor-pointer rounded-[7px] border border-line px-2.5 text-[11px] text-dim transition-colors hover:text-foreground"
          data-testid="market-skills-confirm-cancel"
          @click="confirm = null"
        >
          {{ t("common.cancel") }}
        </button>
      </span>
    </div>
  </div>
</template>
