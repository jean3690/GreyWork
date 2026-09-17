<script setup lang="ts">
import { onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { appEvents } from "@/events";
import { useSkillsStore } from "@/stores/skills";
import Icon from "@/features/shared/Icon.vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/**
 * 技能配置弹窗（远程助手侧）：工作区 `.agents/skills` 下已装的技能。
 *
 * 只读 + 跳转：技能的安装 / 卸载 / 更新全部走技能市场与 设置 → 技能（同一份磁盘真源，
 * 在弹窗里再实现一遍安装流程只会多一条会漂移的写入路径）。ACP agent 新开会话即识别
 * 这些技能，所以远程助手的「能力面」= 这里列出的 + 后端自己的。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const skills = useSkillsStore();

onMounted(() => {
  void skills.refreshInstalled();
});

function openSettings(): void {
  emit("close");
  appEvents.emit("settings:open", { section: "skills" });
}

function onOpenChange(next: boolean): void {
  if (!next) emit("close");
}
</script>

<template>
  <Dialog :open="props.open" @update:open="onOpenChange">
    <DialogContent
      :show-close-button="false"
      class="flex max-h-[88vh] flex-col gap-0 overflow-hidden rounded-[14px] border-line bg-panel p-0 shadow-xl sm:max-w-[520px]"
      data-testid="remote-skills-dialog"
    >
      <div class="flex items-center justify-between px-4 pb-2 pt-3.5">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="grid size-7 shrink-0 place-items-center rounded-[8px] border border-line bg-panel-2 text-dim">
            <Icon name="lightning" :size="14" />
          </span>
          <div class="min-w-0">
            <DialogTitle class="text-[13px] font-medium text-foreground">{{ t("remoteAssist.rows.skillsName") }}</DialogTitle>
            <DialogDescription class="mt-0.5 text-[10.5px] leading-relaxed text-dim2">
              {{ t("remoteAssist.rows.skillsDesc") }}
            </DialogDescription>
          </div>
        </div>
        <button
          type="button"
          class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[6px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
          aria-label="关闭"
          @click="emit('close')"
        >
          <Icon name="close" :size="13" />
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4 pt-1">
        <p class="truncate font-mono text-[10.5px] text-dim2">{{ skills.workspace?.dir ?? ".agents/skills" }}</p>

        <p v-if="skills.installedError" class="text-[11px] text-destructive">{{ skills.installedError }}</p>
        <p v-if="!skills.hostAvailable" class="rounded-[10px] border border-line bg-panel-2 px-3 py-2 text-[11px] text-dim2">
          {{ t("remoteAssist.skills.desktopOnly") }}
        </p>
        <p v-else-if="skills.installed.length === 0" class="rounded-[10px] border border-line bg-panel-2 px-3 py-2 text-[11px] text-dim2">
          {{ skills.installedLoading ? t("remoteAssist.skills.scanning") : t("remoteAssist.skills.empty") }}
        </p>

        <div v-else class="flex flex-col gap-1.5">
          <div
            v-for="skill in skills.installed"
            :key="skill.id"
            class="rounded-[10px] border border-line bg-panel-2 px-3 py-2"
            :data-testid="`skill-row-${skill.id}`"
          >
            <div class="flex items-center gap-1.5">
              <span class="truncate text-[12px] text-foreground">{{ skill.name }}</span>
              <span class="shrink-0 rounded-full border border-line px-1.5 text-[9.5px] font-mono text-dim2">{{ skill.id }}</span>
            </div>
            <p v-if="skill.description" class="mt-0.5 line-clamp-2 text-[10.5px] leading-relaxed text-dim2">{{ skill.description }}</p>
          </div>
        </div>

        <button
          type="button"
          class="h-7 w-fit cursor-pointer rounded-[7px] border border-line bg-panel-2 px-2.5 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
          data-testid="skills-open-settings"
          @click="openSettings"
        >
          {{ t("remoteAssist.skills.openSettings") }}
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>
