<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { Component } from "vue";
import { useChatStore } from "../stores/chat";
import { useProjectStore } from "../stores/project";
import { useAgentStore } from "../stores/agent";
import {
  Bot,
  BarChart3,
  Braces,
  CalendarClock,
  Code2,
  FileText,
  FlaskConical,
  FolderGit2,
  Gauge,
  MessageSquareDashed,
  Plus,
  Puzzle,
  Sparkles,
  TerminalSquare,
  Wrench,
  Zap,
} from "lucide-vue-next";
import MarkdownText from "../components/MarkdownText.vue";
import StreamText from "../components/chat/StreamText.vue";
import ChatComposer from "../components/chat/ChatComposer.vue";
import { stepIcon } from "../lib/icons";
import type { ThreadMessage } from "../types";
import { useI18n } from "vue-i18n";

const { t } = useI18n();
const chat = useChatStore();
const projectStore = useProjectStore();
const agentStore = useAgentStore();
const route = useRoute();
const router = useRouter();

async function goMode(mode: string): Promise<void> {
  await router.push(`/p/${String(route.params.projectId ?? "p-gw-main")}/${mode}`);
}
const acpProviders = computed(() => agentStore.agentProviders);
function acpProviderIcon(id: string): Component {
  if (id === "codex") return Code2;
  if (id === "claude-code") return Sparkles;
  if (id === "opencode") return Braces;
  return TerminalSquare;
}
async function pickAcpProvider(id: string): Promise<void> {
  await agentStore.activateAcpProvider(id);
}

/* 静态 mock 助手卡（彩色头像 = --aion-* 五色，唯一彩色装饰位） */
interface AssistantEntry {
  name: string;
  desc: string;
  icon: Component;
  color: "blue" | "green" | "orange" | "violet" | "red";
  group: string;
  mode?: string;
  prompt?: string;
}
const ASSISTANTS: AssistantEntry[] = [
  {
    name: "Cowork 派工",
    desc: "自主执行：读写文件 · 跑命令 · 修测试",
    icon: Zap,
    color: "orange",
    group: "执行",
    prompt: "梳理项目本周改动并生成日报",
  },
  {
    name: "测试医生",
    desc: "跑全量测试并修复失败用例",
    icon: FlaskConical,
    color: "red",
    group: "执行",
    prompt: "跑一遍测试，修复失败的用例",
  },
  {
    name: "重构顾问",
    desc: "小步重构 + Diff 审阅",
    icon: Wrench,
    color: "blue",
    group: "执行",
    prompt: "重构工作台三栏布局组件，保持行为不变",
  },
  {
    name: "性能体检",
    desc: "定位构建 / 渲染瓶颈并给优化清单",
    icon: Gauge,
    color: "red",
    group: "执行",
    prompt: "给工作台做一次性能体检，列出可优化项",
  },
  { name: "数据洞察", desc: "CSV 即席分析，DuckDB 本地 SQL", icon: BarChart3, color: "green", group: "分析", mode: "analytics" },
  {
    name: "报表小秘",
    desc: "汇总数据与动态，输出 Markdown 报表",
    icon: FileText,
    color: "green",
    group: "分析",
    prompt: "分析站点客流数据并输出报表",
  },
  { name: "多 Agent 编队", desc: "并行派发多个 Agent，流水线协作", icon: Bot, color: "blue", group: "协作与扩展", mode: "agents" },
  { name: "插件侦察", desc: "逛市场找 Skill / MCP，装上即用", icon: Puzzle, color: "violet", group: "协作与扩展", mode: "market" },
  {
    name: "定时自动化",
    desc: "cron / 规则任务，无人值守执行",
    icon: CalendarClock,
    color: "orange",
    group: "协作与扩展",
    mode: "automation",
  },
];

const ASSISTANT_GROUPS = computed(() => {
  const order = ["执行", "分析", "协作与扩展"];
  const map = new Map<string, AssistantEntry[]>();
  for (const a of ASSISTANTS) {
    if (!map.has(a.group)) map.set(a.group, []);
    map.get(a.group)!.push(a);
  }
  return order.filter((g) => map.has(g)).map((g) => ({ label: g, items: map.get(g)! }));
});

const messages = computed<ThreadMessage[]>(() => chat.threads[chat.activeThreadId] ?? []);
const scrollEl = ref<HTMLElement | null>(null);
const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null);
const draft = ref("");
const attachments = ref<string[]>([]);
const projectPopOpen = ref(false);

const showTyping = computed(() => {
  const last = messages.value[messages.value.length - 1];
  return (chat.busy || agentStore.acpBusy) && last?.role === "assistant" && !last.content;
});

/** 该消息是否正处于流式续写（LLM 或 ACP）：流式中用纯文本增量渲染，结束切 Markdown。 */
function isStreaming(m: ThreadMessage): boolean {
  return chat.streamingMessageId === m.id || agentStore.acpStreamId === m.id;
}

const activeThreadProjectName = computed(() => {
  for (const g of projectStore.threadGroups) {
    if (g.threads.some((t) => t.id === chat.activeThreadId)) return g.project ?? null;
  }
  return null;
});

watch(messages, async () => {
  await nextTick();
  scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight, behavior: "smooth" });
});

async function pickAssistant(a: AssistantEntry): Promise<void> {
  if (a.mode) {
    await goMode(a.mode);
    return;
  }
  if (a.prompt) composerRef.value?.fill(a.prompt);
}
async function pickProject(name: string | null): Promise<void> {
  chat.activeThreadId = projectStore.startNewThread(name);
  const match = name ? projectStore.projectByName(name) : null;
  if (match) projectStore.setActiveProject(match.id);
  projectPopOpen.value = false;
}
</script>

<template>
  <section class="chat" :class="{ 'chat--home': !messages.length }">
    <template v-if="!messages.length">
      <div class="chat__scroll chat__scroll--home">
        <div class="home">
          <h1 class="hero__greet">{{ t("chatView.greet") }}</h1>
          <div class="hero__pillbar" role="group" :aria-label="t('chatView.acpCliLabel')">
            <button
              class="hero__cli-target"
              :class="{ active: agentStore.routeToAcp }"
              :title="t('chatView.acpCliHint')"
              @click="goMode('chat')"
            >
              <TerminalSquare class="size-4" />
              ACP CLI
            </button>
            <button
              v-for="provider in acpProviders"
              :key="provider.id"
              class="hero__tool"
              :class="{ active: agentStore.routeToAcp && agentStore.selectedProviderId === provider.id, disabled: !provider.enabled }"
              :title="
                provider.enabled ? t('chatView.useAcp', { name: provider.name }) : t('errors.providerNotEnabled', { name: provider.name })
              "
              :aria-label="provider.name"
              :disabled="!provider.enabled"
              @click="pickAcpProvider(provider.id)"
            >
              <component :is="acpProviderIcon(provider.id)" class="size-3.5" />
            </button>
            <button
              class="hero__tool hero__tool--add"
              :title="t('chatView.manageAcp')"
              :aria-label="t('chatView.manageAcp')"
              @click="goMode('agents')"
            >
              <Plus class="size-3.5" />
            </button>
          </div>
          <ChatComposer ref="composerRef" v-model:draft="draft" v-model:attachments="attachments" class="composer--hero" />
          <div class="home__project">
            <button class="home__project-btn" :class="{ active: projectPopOpen }" @click.stop="projectPopOpen = !projectPopOpen">
              <FolderGit2 class="size-3.5" />
              {{ activeThreadProjectName ? t("chatView.workingOnProject", { name: activeThreadProjectName }) : t("chatView.plainChat") }}
              <span class="composer__caret">▾</span>
            </button>
            <div v-if="projectPopOpen" class="pop pop--project" @click.stop>
              <p class="pop__cap">{{ t("chatView.threadOwner") }}</p>
              <button class="pop__opt pop__opt--row" :class="{ active: !activeThreadProjectName }" @click="pickProject(null)">
                <MessageSquareDashed class="size-3.5" /> {{ t("chatView.plainChatOption") }}
              </button>
              <button
                v-for="p in projectStore.projects"
                :key="p.id"
                class="pop__opt pop__opt--row"
                :class="{ active: activeThreadProjectName === p.name }"
                @click="pickProject(p.name)"
              >
                <FolderGit2 class="size-3.5" /> {{ p.name }}
              </button>
            </div>
          </div>
          <p class="hero__cap">{{ t("chatView.pickAssistant") }}</p>
          <div class="hero__groups">
            <section v-for="group in ASSISTANT_GROUPS" :key="group.label" class="hero__group">
              <p class="hero__group-cap">{{ group.label }}</p>
              <div class="hero__cards">
                <button v-for="a in group.items" :key="a.name" class="hero__card" @click="pickAssistant(a)">
                  <span class="hero__avatar" :class="'hero__avatar--' + a.color"><component :is="a.icon" class="size-4" /></span>
                  <span class="hero__cardbody">
                    <strong>{{ a.name }}</strong>
                    <em>{{ a.desc }}</em>
                  </span>
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </template>
    <template v-else>
      <header class="chat__head">
        <span class="chat__avatar"><Bot class="size-5" /></span>
        <strong>{{ t("chatView.assistantTitle") }}</strong>
        <span class="chat__state" :class="{ 'chat__state--busy': chat.busy || agentStore.acpBusy }">
          <span class="chat__state-dot"></span>{{ chat.busy || agentStore.acpBusy ? t("chatView.busy") : t("chatView.idle") }}
        </span>
        <span v-if="!chat.llmReady" class="chip" :title="t('chatView.demoPipelineHint')">{{ t("chatView.demoPipeline") }}</span>
      </header>
      <div ref="scrollEl" class="chat__scroll">
        <TransitionGroup name="msg">
          <div v-for="m in messages" :key="m.id" class="msg" :class="'msg--' + m.role">
            <div v-if="m.role === 'user'" class="msg__bubble">
              <p>{{ m.content }}</p>
              <div v-if="m.attachments?.length" class="msg__atts">
                <span v-for="a in m.attachments" :key="a"><Paperclip class="size-3" /> {{ a }}</span>
              </div>
            </div>
            <div v-else class="msg__ai">
              <p v-if="m.acp" class="msg__src">ACP · {{ m.acp }}</p>
              <div v-if="m.planPending" class="plan">
                <p class="plan__title">{{ t("chatView.planTitle") }}</p>
                <ol class="plan__list">
                  <li v-for="(s, i) in m.steps" :key="i">
                    <strong>{{ s.label }}</strong
                    ><code>{{ s.detail }}</code>
                  </li>
                </ol>
                <div class="plan__actions">
                  <Button size="sm" @click="chat.confirmPlan(chat.activeThreadId, m)">{{ t("chatView.confirmRun") }}</Button>
                  <Button variant="ghost" size="sm" @click="chat.cancelPlan(chat.activeThreadId, m)">{{ t("common.cancel") }}</Button>
                </div>
              </div>
              <div v-if="m.steps?.length && !m.planPending" class="steps">
                <div v-for="(s, i) in m.steps" :key="i" class="step" :data-status="s.status">
                  <span class="step__icon"><component :is="stepIcon(s.kind)" class="size-3.5" /></span>
                  <span class="step__label">{{ s.label }}</span>
                  <code class="step__detail">{{ s.detail }}</code>
                  <span class="step__state">{{
                    s.status === "done" ? t("chatView.stepDone") : s.status === "running" ? t("chatView.stepRunning") : t("common.waiting")
                  }}</span>
                </div>
              </div>
              <MarkdownText v-if="m.content && !isStreaming(m)" :content="m.content" class="msg__text" />
              <StreamText v-else-if="isStreaming(m)" :content="m.content" />
            </div>
          </div>
        </TransitionGroup>
        <div v-if="showTyping" class="msg msg--assistant">
          <div class="typing" :aria-label="t('chatView.generating')"><i></i><i></i><i></i></div>
        </div>
      </div>
      <ChatComposer v-model:draft="draft" v-model:attachments="attachments" />
    </template>

    <div v-if="agentStore.pendingPermission && messages.length" class="msg msg--assistant">
      <div class="perm-card" data-testid="acp-permission-confirm">
        <p class="perm-card__title">
          {{ t("chatView.permissionRequest") }} · {{ agentStore.pendingPermission.kind
          }}<template v-if="agentStore.pendingPermission.title">：{{ agentStore.pendingPermission.title }}</template>
        </p>
        <div class="perm-card__actions">
          <Button
            v-for="option in agentStore.pendingPermission.options"
            :key="option.optionId"
            size="sm"
            :variant="option.kind.startsWith('allow') ? 'default' : 'ghost'"
            @click="agentStore.respondPermission(option.optionId)"
          >
            {{ option.name }}
          </Button>
          <Button variant="ghost" size="sm" @click="agentStore.respondPermission(null)">{{ t("errors.permissionDenied") }}</Button>
        </div>
      </div>
    </div>
  </section>
</template>
