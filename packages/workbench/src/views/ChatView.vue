<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { Component } from "vue";
import { useChatStore } from "../stores/chat";
import { useProjectStore } from "../stores/project";
import { useAgentStore } from "../stores/agent";
import { Bot, BarChart3, Braces, CalendarClock, Code2, FileText, FlaskConical, FolderGit2, Gauge, MessageSquareDashed, Plus, Puzzle, Sparkles, TerminalSquare, Wrench, Zap } from "lucide-vue-next";
import MarkdownText from "../components/MarkdownText.vue";
import ChatComposer from "../components/chat/ChatComposer.vue";
import { stepIcon } from "../lib/icons";
import type { ThreadMessage } from "../types";

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
  mode?: string;
  prompt?: string;
}
const ASSISTANTS: AssistantEntry[] = [
  { name: "Cowork 派工", desc: "自主执行：读写文件 · 跑命令 · 修测试", icon: Zap, color: "orange", prompt: "梳理项目本周改动并生成日报" },
  { name: "多 Agent 编队", desc: "并行派发多个 Agent，流水线协作", icon: Bot, color: "blue", mode: "agents" },
  { name: "数据洞察", desc: "CSV 即席分析，DuckDB 本地 SQL", icon: BarChart3, color: "green", mode: "analytics" },
  { name: "测试医生", desc: "跑全量测试并修复失败用例", icon: FlaskConical, color: "red", prompt: "跑一遍测试，修复失败的用例" },
  { name: "重构顾问", desc: "小步重构 + Diff 审阅", icon: Wrench, color: "blue", prompt: "重构工作台三栏布局组件，保持行为不变" },
  { name: "插件侦察", desc: "逛市场找 Skill / MCP，装上即用", icon: Puzzle, color: "violet", mode: "market" },
  { name: "定时自动化", desc: "cron / 规则任务，无人值守执行", icon: CalendarClock, color: "orange", mode: "automation" },
  { name: "报表小秘", desc: "汇总数据与动态，输出 Markdown 报表", icon: FileText, color: "green", prompt: "分析站点客流数据并输出报表" },
  { name: "性能体检", desc: "定位构建 / 渲染瓶颈并给优化清单", icon: Gauge, color: "red", prompt: "给工作台做一次性能体检，列出可优化项" },
];

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
          <h1 class="hero__greet">今天准备处理什么？</h1>
          <div class="hero__pillbar" role="group" aria-label="ACP CLI 后端">
            <button class="hero__cli-target" :class="{ active: agentStore.routeToAcp }" title="ACP 派发已启用时，消息将发送给当前 CLI 后端" @click="goMode('chat')">
              <TerminalSquare class="size-4" />
              ACP CLI
            </button>
            <button
              v-for="provider in acpProviders"
              :key="provider.id"
              class="hero__tool"
              :class="{ active: agentStore.routeToAcp && agentStore.selectedProviderId === provider.id, disabled: !provider.enabled }"
              :title="provider.enabled ? '使用 ACP · ' + provider.name : provider.name + ' 尚未启用'"
              :aria-label="provider.name"
              :disabled="!provider.enabled"
              @click="pickAcpProvider(provider.id)"
            >
              <component :is="acpProviderIcon(provider.id)" class="size-3.5" />
            </button>
            <button class="hero__tool hero__tool--add" title="管理 ACP 后端" aria-label="管理 ACP 后端" @click="goMode('agents')">
              <Plus class="size-3.5" />
            </button>
          </div>
          <ChatComposer ref="composerRef" v-model:draft="draft" v-model:attachments="attachments" class="composer--hero" />
          <div class="home__project">
            <button
              class="home__project-btn"
              :class="{ active: projectPopOpen }"
              @click.stop="projectPopOpen = !projectPopOpen"
            >
              <FolderGit2 class="size-3.5" />
              {{ activeThreadProjectName ? "工作于项目 · " + activeThreadProjectName : "普通对话 · 未绑定项目" }}
              <span class="composer__caret">▾</span>
            </button>
            <div v-if="projectPopOpen" class="pop pop--project" @click.stop>
              <p class="pop__cap">新对话归属</p>
              <button
                class="pop__opt pop__opt--row"
                :class="{ active: !activeThreadProjectName }"
                @click="pickProject(null)"
              >
                <MessageSquareDashed class="size-3.5" /> 普通对话（不绑定项目）
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
          <p class="hero__cap">或选择一个助手开始任务</p>
          <div class="hero__cards">
            <button v-for="a in ASSISTANTS" :key="a.name" class="hero__card" @click="pickAssistant(a)">
              <span class="hero__avatar" :class="'hero__avatar--' + a.color"><component :is="a.icon" class="size-4" /></span>
              <span class="hero__cardbody">
                <strong>{{ a.name }}</strong>
                <em>{{ a.desc }}</em>
              </span>
            </button>
          </div>
        </div>
      </div>
    </template>
    <template v-else>
      <header class="chat__head">
        <span class="chat__avatar"><Bot class="size-5" /></span>
        <strong>GreyWork 助手</strong>
        <span class="chat__state" :class="{ 'chat__state--busy': chat.busy || agentStore.acpBusy }">
          <span class="chat__state-dot"></span>{{ chat.busy || agentStore.acpBusy ? "执行中" : "空闲" }}
        </span>
        <span v-if="!chat.llmReady" class="chip" title="未配置已启用的模型供应商，当前为演示时间线；可在 设置 → 模型供应商 配置"
          >演示管线</span
        >
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
                <p class="plan__title">实施计划 · 确认后执行</p>
                <ol class="plan__list">
                  <li v-for="(s, i) in m.steps" :key="i">
                    <strong>{{ s.label }}</strong><code>{{ s.detail }}</code>
                  </li>
                </ol>
                <div class="plan__actions">
                  <Button size="sm" @click="chat.confirmPlan(chat.activeThreadId, m)">确认执行</Button>
                  <Button variant="ghost" size="sm" @click="chat.cancelPlan(chat.activeThreadId, m)">取消</Button>
                </div>
              </div>
              <div v-if="m.steps?.length && !m.planPending" class="steps">
                <div v-for="(s, i) in m.steps" :key="i" class="step" :data-status="s.status">
                  <span class="step__icon"><component :is="stepIcon(s.kind)" class="size-3.5" /></span>
                  <span class="step__label">{{ s.label }}</span>
                  <code class="step__detail">{{ s.detail }}</code>
                  <span class="step__state">{{ s.status === "done" ? "✓ 完成" : s.status === "running" ? "运行中…" : "等待" }}</span>
                </div>
              </div>
              <MarkdownText v-if="m.content" :content="m.content" class="msg__text" />
            </div>
          </div>
        </TransitionGroup>
        <div v-if="showTyping" class="msg msg--assistant">
          <div class="typing" aria-label="正在生成"><i></i><i></i><i></i></div>
        </div>
      </div>
      <ChatComposer v-model:draft="draft" v-model:attachments="attachments" />
    </template>

    <div v-if="agentStore.pendingPermission && messages.length" class="msg msg--assistant">
      <div class="perm-card" data-testid="acp-permission-confirm">
        <p class="perm-card__title">
          权限请求 · {{ agentStore.pendingPermission.kind
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
          <Button variant="ghost" size="sm" @click="agentStore.respondPermission(null)">拒绝</Button>
        </div>
      </div>
    </div>
  </section>
</template>
