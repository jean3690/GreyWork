<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ArrowLeft, ArrowRight, CalendarClock, Plus, Search, Settings } from "lucide-vue-next";
import { capabilitySeam } from "../plugins/loader";
import { useChatStore } from "../stores/chat";
import { useWorkspaceStore } from "../stores/workspace";
import { useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import { getPluginMarket } from "../state/pluginMarket";
import { createWebSearchClient, selectWebSearchProvider, type WebSearchHit } from "@greywork/shell";
import { useI18n } from "vue-i18n";

defineProps<{ collapsed: boolean }>();

const { t } = useI18n();

const chat = useChatStore();
const workspaceStore = useWorkspaceStore();
const sessionStore = useSessionStore();
const settings = useSettingsStore();
const pluginMarket = getPluginMarket();
const route = useRoute();
const router = useRouter();

const sections = computed(() => capabilitySeam.snapshot().uiRegions.filter((entry) => entry.region === "shellSidebar"));

/* 返回 / 前进 */
function goBack(): void {
  router.back();
}
function goForward(): void {
  router.forward();
}

/* 新对话（归属当前项目） */
async function newThread(): Promise<void> {
  const workspace = workspaceStore.workspaces.find((candidate) => candidate.id === workspaceStore.activeWorkspaceId);
  chat.activeThreadId = sessionStore.createSession(workspace?.id ?? null).id;
  await router.push(`/p/${String(workspaceStore.activeWorkspaceId ?? "p-gw-main")}/chat`);
}

/* 设置：固定在侧栏左下角 */
async function goSettings(): Promise<void> {
  await router.push(`/p/${String(route.params.projectId ?? "p-gw-main")}/settings`);
}

/* 定时任务：进入自动化 mode */
async function goAutomation(): Promise<void> {
  await router.push(`/p/${String(route.params.projectId ?? "p-gw-main")}/automation`);
}

const activeMode = computed(() => String(route.params.mode ?? "chat"));

/* 全局搜索：线程 / 插件（本地）+ 网页（宿主代理） */
const searchOpen = ref(false);
const searchInput = ref("");
const searchFocus = ref(false);

const webSearchClient = createWebSearchClient();
const webHits = ref<WebSearchHit[]>([]);
const webSearching = ref(false);
const webError = ref("");
let webDebounce: ReturnType<typeof setTimeout> | null = null;

async function runWebSearch(query: string): Promise<void> {
  const provider = selectWebSearchProvider(settings.webSearchProviders);
  if (!provider || !webSearchClient.isAvailable() || query.trim().length < 2) {
    webHits.value = [];
    webError.value = "";
    return;
  }
  webSearching.value = true;
  webError.value = "";
  try {
    webHits.value = await webSearchClient.search(
      { providerId: provider.id, endpoint: provider.endpoint ?? "", apiKeyEnv: provider.apiKeyEnv },
      query,
      5,
    );
  } catch (error) {
    webHits.value = [];
    webError.value = error instanceof Error ? error.message : String(error);
  } finally {
    webSearching.value = false;
  }
}

function copyWebResult(url: string): void {
  void navigator.clipboard?.writeText(url);
}

watch(searchInput, (value) => {
  searchOpen.value = value.trim().length > 0;
  if (webDebounce) clearTimeout(webDebounce);
  webDebounce = setTimeout(() => void runWebSearch(value), 400);
});
onBeforeUnmount(() => {
  if (webDebounce) clearTimeout(webDebounce);
});

interface SearchResult {
  kind: "thread" | "plugin";
  id: string;
  title: string;
  sub: string;
}

const allThreads = computed(() =>
  sessionStore.sessions.map((session) => ({
    id: session.id,
    title: session.title,
    workspace: session.workspaceId
      ? (workspaceStore.workspaceById(session.workspaceId)?.name ?? t("sidebar.plainChat"))
      : t("sidebar.plainChat"),
  })),
);

const searchResults = computed<SearchResult[]>(() => {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) return [];
  const threadHits = allThreads.value
    .filter((t) => t.title.toLowerCase().includes(query) || t.workspace.toLowerCase().includes(query))
    .slice(0, 6)
    .map((t) => ({ kind: "thread" as const, id: t.id, title: t.title, sub: t.workspace }));
  const pluginHits = pluginMarket.marketplace
    .filter((m) => (m.name + " " + (m.description ?? "")).toLowerCase().includes(query))
    .slice(0, 5)
    .map((m) => ({ kind: "plugin" as const, id: m.id, title: m.name, sub: m.description ?? "" }));
  return [...threadHits, ...pluginHits];
});

async function openSearchResult(result: SearchResult): Promise<void> {
  if (result.kind === "thread") {
    chat.activeThreadId = result.id;
    chat.ensure(result.id);
    await router.push(`/p/${String(route.params.projectId ?? workspaceStore.workspaces[0]?.id)}/chat`);
  } else {
    await router.push({
      path: `/p/${String(route.params.projectId ?? workspaceStore.workspaces[0]?.id)}/market`,
      query: { plugin: result.id },
    });
  }
  searchOpen.value = false;
  searchInput.value = "";
}
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }" data-testid="shell-sidebar">
    <div class="sidebar__top">
      <span class="sidebar__brand"><span class="sidebar__mark">G</span>GreyWork</span>
      <button class="sidebar__navbtn" :title="t('sidebar.back')" :aria-label="t('sidebar.back')" @click="goBack">
        <ArrowLeft class="size-4" />
      </button>
      <button class="sidebar__navbtn" :title="t('sidebar.forward')" :aria-label="t('sidebar.forward')" @click="goForward">
        <ArrowRight class="size-4" />
      </button>
    </div>

    <div class="sidebar__quick">
      <button class="sidebar__quick-item sidebar__new" :title="t('sidebar.newThreadHint', { shortcut: 'Ctrl/Cmd+K' })" @click="newThread">
        <Plus class="size-3.5" />{{ t("sidebar.newThread") }}
      </button>
      <div class="sidebar__search">
        <div class="sidebar__search-box">
          <Search class="size-3.5" />
          <input
            v-model="searchInput"
            :placeholder="t('sidebar.searchPlaceholder')"
            :aria-label="t('sidebar.searchAria')"
            @focus="searchFocus = true"
            @blur="searchFocus = false"
            @keydown.esc="searchInput = ''"
          />
        </div>
        <div v-if="searchOpen && searchFocus" class="sb-search-pop" data-testid="sidebar-search">
          <template v-if="searchResults.length">
            <button v-for="r in searchResults" :key="r.kind + r.id" class="sb-search-hit" @mousedown.prevent="openSearchResult(r)">
              {{ r.title }}<em>{{ r.sub }}</em>
            </button>
          </template>
          <template v-if="webHits.length">
            <button v-for="hit in webHits" :key="hit.url" class="sb-search-hit" @mousedown.prevent="copyWebResult(hit.url)">
              {{ hit.title }}<em>{{ hit.snippet }}</em>
            </button>
            <p class="footnote">
              {{
                t("sidebar.copyLinkSource", {
                  provider: selectWebSearchProvider(settings.webSearchProviders)?.name ?? t("sidebar.webSearchDefault"),
                })
              }}
            </p>
          </template>
          <p v-if="webSearching" class="footnote">{{ t("sidebar.webSearching") }}</p>
          <p v-if="webError" class="footnote">{{ t("sidebar.webSearchFailed", { detail: webError }) }}</p>
          <p v-if="!searchResults.length && !webHits.length && !webSearching && !webError" class="footnote">{{ t("sidebar.noResults") }}</p>
        </div>
      </div>
      <button class="sidebar__quick-item" :class="{ active: activeMode === 'automation' }" @click="goAutomation">
        <CalendarClock class="size-3.5" />{{ t("sidebar.automation") }}
      </button>
    </div>

    <div class="sidebar__body">
      <component :is="section.component" v-for="section in sections" :key="section.id" />
    </div>

    <div class="sidebar__foot">
      <button class="sidebar__foot-btn" :title="t('sidebar.settings')" :aria-label="t('sidebar.settings')" @click="goSettings">
        <Settings class="size-4" />
        <span>{{ t("sidebar.settings") }}</span>
      </button>
      <span class="sidebar__avatar" title="JF · jean">JF</span>
    </div>
  </aside>
</template>
