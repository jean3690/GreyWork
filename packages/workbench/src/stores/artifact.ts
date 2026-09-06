import type { Artifact, ReviewItem, SourceRef } from "../types";
import { appEvents } from "../events";
import { useVfsStore } from "./vfs";
import { saveArtifactToDisk } from "../lib/artifact-dir";
import { createIdFactory } from "@greywork/core";
import { defineStore } from "pinia";
import { ref } from "vue";

const nextArtifactId = createIdFactory("af-live");

/** 交付物投递说明：落盘内容 + 卡片元信息，由 deliverArtifact 一次性完成整条链路。 */
export interface ArtifactDelivery {
  /** 交付物展示名；缺省时取 path 末段。 */
  name?: string;
  /** VFS 路径（产物查看器据此打开 tab）。 */
  path: string;
  meta: string;
  type: Artifact["type"];
  source: string;
  format?: Artifact["format"];
  /**
   * 落盘内容：string → 文本写入，Uint8Array → 二进制写入，
   * 省略 → 调用方已自行落盘（仅登记卡片并广播）。
   */
  data?: string | Uint8Array;
  /** 调用方已自行落盘时可直接带入磁盘路径（与 data 二选一）。 */
  diskPath?: string;
  /** 就地修改既有交付物：广播 artifact:updated（查看器重载该 tab）而非 created。 */
  updated?: boolean;
}

/**
 * 活动产物：交付物 / 审查 / 来源（ActivityPanel 数据源；Diff 由 vfsStore 驱动）。
 * 初始为空：早期版本首启塞示例交付物，全新用户会被「昨天做过什么」的假象误导；
 * 产物只应来自真实运行（deliverArtifact / 审查管线）。
 */
export const useArtifactStore = defineStore("artifact", () => {
  const vfsStore = useVfsStore();
  const artifacts = ref<Artifact[]>([]);
  const reviewItems = ref<ReviewItem[]>([]);
  const sources = ref<SourceRef[]>([]);

  /** 交付物流线终点：追加一条交付物卡片并返回其 id。 */
  function pushArtifact(
    input: Pick<Artifact, "name" | "meta" | "type" | "source"> & { format?: Artifact["format"]; path?: string; diskPath?: string },
  ): string {
    const id = nextArtifactId();
    artifacts.value.unshift({ ...input, id, createdAt: Date.now() });
    return id;
  }

  /**
   * 交付物唯一出口：落盘 VFS → 登记 Artifacts 卡片 → 广播事件，返回卡片 id。
   * 三步必须同时发生，此前散落在 chat / deck / analytics 的 9 处手写副本里，
   * 其中 analytics 两处漏了广播，导致导出后查看器不自动开 tab。
   */
  async function deliverArtifact(input: ArtifactDelivery): Promise<string> {
    const name = input.name ?? input.path.split("/").pop() ?? input.path;
    if (typeof input.data === "string") await vfsStore.write(input.path, input.data);
    else if (input.data) await vfsStore.writeBinary(input.path, input.data);
    // 默认落盘：工作区 artifacts/（或 ~/.greyWork/artifacts/）；失败不影响查看器登记。
    // 落盘路径要留在卡片上，否则「在文件夹中打开」无从定位（此前返回值被丢弃）。
    const diskPath = input.data ? await saveArtifactToDisk(name, input.data) : input.diskPath;
    const id = pushArtifact({
      name,
      meta: input.meta,
      type: input.type,
      source: input.source,
      format: input.format,
      diskPath: diskPath ?? undefined,
      path: input.path,
    });
    appEvents.emit(input.updated ? "artifact:updated" : "artifact:created", {
      name,
      path: input.path,
      format: input.format,
      source: input.source,
    });
    return id;
  }

  /** 按 id 取交付物（ThreadMessage.artifacts 存的是 id，渲染侧需回查）。 */
  function byId(id: string): Artifact | undefined {
    return artifacts.value.find((artifact) => artifact.id === id);
  }

  return { artifacts, reviewItems, sources, pushArtifact, deliverArtifact, byId };
});
