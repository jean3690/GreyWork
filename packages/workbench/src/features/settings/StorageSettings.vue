<script setup lang="ts">
/**
 * 存储设置：会话落到哪里，以及浏览器态的远端目录配置。
 *
 * 桌面态的落盘位置由工作区绑定决定（无需配置）；浏览器态没有磁盘通道，只有配了
 * WebDAV 才算真落盘 —— 这一页把两者的现状摊开，避免用户以为浏览器里也在写盘。
 */
import { onMounted, ref } from "vue";
import { isTauriRuntime } from "@greywork/core";
import { createWebdavClient } from "@/lib/webdav";
import { isRemoteStoreEnabled, readRemoteStoreConfig, writeRemoteStoreConfig, type RemoteStoreConfig } from "@/lib/remote-store-config";
import Icon from "@/features/shared/Icon.vue";

const desktop = isTauriRuntime();

const draft = ref<RemoteStoreConfig>({ kind: "off", url: "" });
const saved = ref(false);
const probing = ref(false);
const probeResult = ref<string | null>(null);

onMounted(() => {
  draft.value = { ...readRemoteStoreConfig() };
});

function save(): void {
  writeRemoteStoreConfig(draft.value);
  draft.value = { ...readRemoteStoreConfig() };
  saved.value = true;
  probeResult.value = null;
}

/** 探针：建目录 → 写一个临时文件 → 删掉。三步都过才算这套凭据真的能写。 */
async function probe(): Promise<void> {
  probing.value = true;
  probeResult.value = null;
  try {
    const client = createWebdavClient(draft.value);
    await client.ensureDir("sessions");
    await client.putText("sessions/.greywork-probe", "ok");
    await client.del("sessions/.greywork-probe");
    probeResult.value = "连接正常，目录可写";
  } catch (error) {
    probeResult.value = `连接失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    probing.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-2 text-[13px] font-medium text-foreground">当前落盘位置</div>
      <div v-if="desktop" class="flex flex-col gap-1 font-mono text-[11px] text-dim2">
        <span>未绑定工作区的会话 → ~/.greyWork/sessions/</span>
        <span>已绑定工作区的会话 → &lt;工作区文件夹&gt;/.greyWork/sessions/</span>
      </div>
      <div v-else class="text-[11.5px] text-dim2">
        {{
          isRemoteStoreEnabled(draft)
            ? "浏览器态：会话推送到下方 WebDAV 目录（sessions/ 平铺，工作区归属记在会话内）。"
            : "浏览器态：当前只存在浏览器 localStorage 里，换浏览器/清缓存即丢。配好下面的 WebDAV 才算真落盘。"
        }}
      </div>
    </div>

    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-3 text-[13px] font-medium text-foreground">远端存储（WebDAV）</div>
      <div class="mb-3 flex gap-2">
        <button
          v-for="kind in ['off', 'webdav'] as const"
          :key="kind"
          type="button"
          :data-testid="`remote-store-kind-${kind}`"
          class="flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-line px-3 py-1.5 text-[12px] transition-colors"
          :class="draft.kind === kind ? 'bg-panel-2 text-foreground' : 'text-dim hover:bg-panel-2'"
          :aria-pressed="draft.kind === kind"
          @click="draft.kind = kind"
        >
          {{ kind === "off" ? "关闭" : "WebDAV" }}
        </button>
      </div>

      <div v-if="draft.kind === 'webdav'" class="flex flex-col gap-2">
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-dim2">目录地址</span>
          <input
            v-model="draft.url"
            data-testid="remote-store-url"
            type="url"
            placeholder="https://dav.example.com/greywork"
            class="h-8 rounded-[8px] border border-line-2 bg-panel-2 px-2 font-mono text-[12px] text-foreground outline-none focus-visible:border-cyan"
          />
        </label>
        <div class="flex gap-2">
          <label class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="text-[11px] text-dim2">用户名</span>
            <input
              v-model="draft.username"
              type="text"
              autocomplete="off"
              class="h-8 rounded-[8px] border border-line-2 bg-panel-2 px-2 text-[12px] text-foreground outline-none focus-visible:border-cyan"
            />
          </label>
          <label class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="text-[11px] text-dim2">密码</span>
            <input
              v-model="draft.password"
              type="password"
              autocomplete="off"
              class="h-8 rounded-[8px] border border-line-2 bg-panel-2 px-2 text-[12px] text-foreground outline-none focus-visible:border-cyan"
            />
          </label>
        </div>
        <p class="flex items-start gap-1.5 text-[11px] text-amber">
          <Icon name="shield" :size="12" class="mt-0.5 shrink-0" />
          凭据以明文存在浏览器 localStorage：只用于自建/局域网端点，并且请用只对该目录有权限的专用账号。
        </p>
      </div>

      <div class="mt-3 flex items-center gap-2">
        <button
          type="button"
          data-testid="remote-store-save"
          class="flex h-7 cursor-pointer items-center rounded-[8px] border border-line-2 bg-panel-2 px-3 text-[12px] text-foreground transition-colors hover:border-cyan"
          @click="save"
        >
          保存
        </button>
        <button
          type="button"
          data-testid="remote-store-test"
          :disabled="draft.kind !== 'webdav' || !draft.url.trim() || probing"
          class="flex h-7 cursor-pointer items-center rounded-[8px] border border-line px-3 text-[12px] text-dim transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          @click="probe"
        >
          {{ probing ? "测试中…" : "测试连接" }}
        </button>
        <span v-if="saved" class="text-[11px] text-dim2">已保存，下次同步生效</span>
      </div>
      <p v-if="probeResult" role="status" class="mt-2 text-[11px] text-dim">{{ probeResult }}</p>
    </div>
  </div>
</template>
