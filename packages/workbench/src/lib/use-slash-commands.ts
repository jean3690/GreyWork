/**
 * 斜杠命令菜单状态机：开合判定、键盘导航、选中执行（内置动作 / 模板填充 / ACP 命令）。
 *
 * 会话页与引导页共用同一份实现 —— 两边的差异只在「发送入口」和「是否可发送」，
 * 其余（触发、过滤、键盘、选中语义）完全同构。内置命令直接读写 settings/chat store；
 * ACP 命令无参时经 onSend 立即发出，带参或不可发送时插回草稿待用户确认。
 *
 * 键盘事件在视图的 Enter 发送之前调用 handleKeydown，返回 true 表示已消费。
 */

import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from "vue";
import { i18n } from "../i18n";
import { useAgentStore } from "../stores/agent";
import { useChatStore } from "../stores/chat";
import { useSettingsStore } from "../stores/settings";
import { buildSlashItems, filterSlashCommands, matchSlashQuery, slashOptionId, type SlashCommandItem } from "./slash-commands";

export interface UseSlashCommandsOptions {
  /** 输入框草稿（菜单触发源；选中后也写回这里）。 */
  draft: Ref<string>;
  /** 输入框元素：选中后回焦并把光标放到末尾。 */
  textarea: Ref<HTMLTextAreaElement | null>;
  /** 视图侧发送入口：文本已就绪，附件与后端路由等原有语义由视图处理。 */
  onSend: (text: string) => void;
  /** 当前是否可发送；不可发送时 ACP 无参命令降级为「插入待发」，不丢命令也不误发。 */
  canSend?: () => boolean;
}

export interface UseSlashCommands {
  open: ComputedRef<boolean>;
  items: ComputedRef<SlashCommandItem[]>;
  activeIndex: Ref<number>;
  /** 高亮项对应的 option DOM id（textarea 的 aria-activedescendant）。 */
  activeOptionId: ComputedRef<string | undefined>;
  /** 菜单打开时消费方向键 / Enter / Tab / Esc；返回 true 表示视图不应再处理该键。 */
  handleKeydown: (event: KeyboardEvent) => boolean;
  select: (index: number) => void;
  dismiss: () => void;
}

export function useSlashCommands(options: UseSlashCommandsOptions): UseSlashCommands {
  const settings = useSettingsStore();
  const chat = useChatStore();
  const agent = useAgentStore();
  const t = i18n.global.t;

  /** Esc 主动关闭：保持关闭直到草稿离开「/命令词」形态（离开后再次输入可重新触发）。 */
  const dismissed = ref(false);
  const activeIndex = ref(0);

  const query = computed(() => matchSlashQuery(options.draft.value));
  const allItems = computed(() =>
    buildSlashItems({
      t: (key: string) => t(key),
      acpCommands: agent.acpCommands,
      routeToAcp: agent.routeToAcp,
      planMode: settings.planMode,
      speedBoost: chat.speedBoost,
    }),
  );
  const items = computed(() => (query.value === null ? [] : filterSlashCommands(allItems.value, query.value)));
  const open = computed(() => query.value !== null && !dismissed.value);
  const activeOptionId = computed(() => {
    if (!open.value) return undefined;
    const item = items.value[activeIndex.value];
    return item ? slashOptionId(item) : undefined;
  });

  watch(query, (value) => {
    if (value === null) dismissed.value = false;
  });
  // 打字收窄列表后高亮回到第一项（方向键不触发重算，不会被抢走）。
  watch(items, () => {
    activeIndex.value = 0;
  });

  function focusTextarea(): void {
    void nextTick(() => {
      const el = options.textarea.value;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }

  function fill(text: string): void {
    options.draft.value = text;
    focusTextarea();
  }

  function dismiss(): void {
    dismissed.value = true;
  }

  function select(index: number): void {
    const item = items.value[index];
    if (!item) return;

    if (item.source === "builtin") {
      if (item.builtinKind === "toggle") {
        // 开关类：动作即反馈（composer 状态胶囊随之显隐），草稿清空。
        if (item.name === "plan") settings.planMode = !settings.planMode;
        else if (item.name === "speed") chat.speedBoost = !chat.speedBoost;
        options.draft.value = "";
        focusTextarea();
      } else if (item.templateKey) {
        fill(t(item.templateKey));
      }
      return;
    }

    // ACP 命令：协议侧名称不带斜杠，发送时补回。
    const command = `/${item.name}`;
    if (!item.requiresInput && (options.canSend?.() ?? true)) {
      options.onSend(command);
      return;
    }
    fill(`${command} `);
  }

  function handleKeydown(event: KeyboardEvent): boolean {
    // 输入法合成中（keyCode 229 是老浏览器 / IME 的兜底）：Enter 归候选词确认，菜单不抢键。
    if (event.isComposing || event.keyCode === 229) return false;
    if (!open.value) return false;

    if (event.key === "Escape") {
      dismiss();
      event.preventDefault();
      return true;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const count = items.value.length;
      if (count > 0) {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        activeIndex.value = (activeIndex.value + delta + count) % count;
      }
      event.preventDefault();
      return true;
    }

    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      // 无匹配时不消费：`/zzz` 仍可当普通消息回车发出。
      if (items.value.length === 0) return false;
      event.preventDefault();
      select(activeIndex.value);
      return true;
    }

    return false;
  }

  return { open, items, activeIndex, activeOptionId, handleKeydown, select, dismiss };
}
