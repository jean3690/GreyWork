<script setup lang="ts">
/**
 * 输入卡附件托盘：图片出缩略图，文本出文件名 chip，右上角可移除。
 *
 * 缩略图经 attachmentObjectUrl 读取（磁盘附件 → blob URL，走模块级 LRU），
 * 读不到（文件被移动/删除）时不报错，退化为「已不可用」占位 —— 已发送的历史消息
 * 里的附件同样可能失效，占位比报错更符合「会话还能继续读」的预期。
 */
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import { useAttachmentThumbs } from "../../lib/use-attachments";
import { formatBytes } from "../../lib/attachments";
import type { Attachment } from "../../types";

const props = defineProps<{ items: readonly Attachment[] }>();
const emit = defineEmits<{ remove: [id: string] }>();

const { t } = useI18n();

/** 缩略图 URL（null = 读取失败 → 渲染占位）；URL 由模块级 LRU 管理，组件不 revoke。 */
const thumbs = useAttachmentThumbs(() => props.items);
</script>

<template>
  <div
    v-if="items.length"
    data-testid="composer-attachments"
    role="list"
    class="flex min-w-0 flex-wrap items-center gap-2 border-t border-line/70 px-2 pt-2"
  >
    <div
      v-for="item in items"
      :key="item.id"
      role="listitem"
      data-testid="attachment-chip"
      :data-attachment-kind="item.kind"
      class="group relative flex items-center gap-2 rounded-[10px] border border-line bg-panel p-1.5 pr-6"
    >
      <img
        v-if="item.kind === 'image' && thumbs[item.id]"
        :src="thumbs[item.id] as string"
        :alt="item.name"
        class="size-12 shrink-0 rounded-[7px] object-cover"
      />
      <span
        v-else-if="item.kind === 'image'"
        class="grid size-12 shrink-0 place-items-center rounded-[7px] bg-panel-2 px-1 text-center text-[9px] leading-tight text-dim2"
      >
        {{ t("chat.attachUnavailable") }}
      </span>
      <span v-else class="flex min-w-0 max-w-[200px] items-center gap-1.5">
        <Icon name="file" :size="13" class="text-dim" />
        <span class="min-w-0">
          <span class="block truncate text-[11.5px] text-foreground">{{ item.name }}</span>
          <span class="block text-[10px] text-dim2">{{ formatBytes(item.size) }}{{ item.truncated ? " · 已截断" : "" }}</span>
        </span>
      </span>
      <button
        type="button"
        data-testid="attachment-remove"
        class="absolute right-1 top-1 grid size-4 cursor-pointer place-items-center rounded-full bg-panel-2 text-dim2 transition-colors hover:bg-line-2 hover:text-foreground"
        :aria-label="t('chat.attachRemove', { name: item.name })"
        :title="t('chat.attachRemove', { name: item.name })"
        @click="emit('remove', item.id)"
      >
        <Icon name="close-one" :size="9" />
      </button>
    </div>
  </div>
</template>
