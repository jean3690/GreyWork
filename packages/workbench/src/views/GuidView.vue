<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAgentStore } from "../stores/agent";
import { useChatStore } from "../stores/chat";
import { useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import { useWorkspaceStore } from "../stores/workspace";
import AcpSessionConfig from "../components/AcpSessionConfig.vue";
import AgentProviderBar from "../components/AgentProviderBar.vue";
import Icon from "../components/Icon.vue";

/**
 * GreyWork 风格新对话引导页：hero + 快捷入口 + 输入卡。
 * 提交 → 新建会话 → 走 chat 管线（mock/真实 LLM）→ 跳到对话页。
 */
const router = useRouter();
const agent = useAgentStore();
const chat = useChatStore();
const sessionStore = useSessionStore();
const workspaceStore = useWorkspaceStore();
const settings = useSettingsStore();

const draft = ref("");

const quickActions: { label: string; hint: string; prompt: string; icon: string }[] = [
  { label: "日报", hint: "梳理改动 · 生成报告", prompt: "梳理项目本周改动并生成日报", icon: "lightning" },
  { label: "测试医生", hint: "跑全量测试并修复失败用例", prompt: "跑一遍测试，修复失败的用例", icon: "shield" },
  { label: "重构顾问", hint: "小步重构 + Diff 审阅", prompt: "重构工作台三栏布局组件，保持行为不变", icon: "hammer" },
  { label: "性能体检", hint: "定位瓶颈 · 给优化清单", prompt: "给工作台做一次性能体检，列出可优化项", icon: "refresh" },
  { label: "数据洞察", hint: "CSV 即席分析", prompt: "分析站点客流数据并输出报表", icon: "earth" },
  { label: "定时自动化", hint: "无人值守执行", prompt: "帮我配置一个每天 09:00 的自动化任务", icon: "alarm-clock" },
];

function run(prompt: string): void {
  const workspaceId = workspaceStore.activeWorkspaceId;
  const session = sessionStore.createSession(workspaceId);
  sessionStore.setActive(session.id);
  chat.activeThreadId = session.id;
  if (prompt.trim()) {
    if (agent.routeToAcp) {
      // ACP agent 选中：回合由宿主事件驱动（chunk/权限/停止），不进 LLM 管线。
      void agent.dispatchToAcp(prompt);
    } else if (agent.maybeOrchestrate(prompt)) {
      // 编排意图（「自动执行/编排 …」）：planner 拆解 → 并行子任务，TeamView 看板跟踪。
    } else {
      chat.submitText(prompt);
    }
  }
  void router.push(`/conversation/${session.id}`);
}

function onSubmit(): void {
  if (!draft.value.trim()) return;
  run(draft.value);
  draft.value = "";
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    onSubmit();
  }
}
</script>

<template>
  <section class="mx-auto flex min-h-0 w-full max-w-[800px] flex-col items-center px-4 pt-[6vh] pb-8">
    <div class="flex w-full flex-col items-center gap-5">
      <div class="flex flex-col items-center gap-3 text-center">
        <span class="grid size-12 place-items-center rounded-[14px] bg-console">
          <span class="font-display text-2xl font-extrabold leading-none text-white">A</span>
        </span>
        <h1 class="font-display text-[26px] font-bold tracking-tight text-foreground">你好，我是 GreyWork</h1>
        <p class="text-[13px] leading-relaxed text-dim">问问题、改代码、出报告——说人话就行，剩下的交给我。</p>
      </div>

      <div class="grid w-full grid-cols-2 gap-2 sm:grid-cols-3">
        <button
          v-for="action in quickActions"
          :key="action.label"
          class="flex cursor-pointer flex-col gap-1 rounded-[14px] border border-line bg-panel p-3 text-left transition-colors hover:border-line-2 hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="run(action.prompt)"
        >
          <span class="flex items-center gap-2 text-[13px] font-medium text-foreground">
            <span class="grid size-6 place-items-center rounded-[7px] bg-panel-2 text-dim">
              <Icon :name="action.icon" :size="14" />
            </span>
            {{ action.label }}
          </span>
          <span class="line-clamp-2 text-[11px] leading-snug text-dim2">{{ action.hint }}</span>
        </button>
      </div>

      <div class="flex w-full flex-col gap-2">
        <AgentProviderBar />
        <div class="flex w-full flex-col gap-2 rounded-[16px] border border-line bg-panel p-2.5 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
          <textarea
            v-model="draft"
            rows="3"
            class="w-full resize-none bg-transparent px-2 py-1 text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-dim2"
            placeholder="描述你想做的事，回车发送…"
            :aria-label="'发送消息'"
            @keydown="onKeydown"
          />
          <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
            <span class="pl-2 text-[11px] text-dim2">
              运行模式 · {{ settings.runMode === "cloud" ? "Cloud" : settings.runMode === "worktree" ? "Worktree" : "Local" }}
            </span>
            <div class="flex flex-wrap items-center justify-end gap-1.5">
              <AcpSessionConfig />
              <button
                class="flex h-8 cursor-pointer items-center gap-1.5 rounded-[10px] bg-console px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="!draft.trim()"
                @click="onSubmit"
              >
                发送
                <Icon name="send-one" :size="13" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
