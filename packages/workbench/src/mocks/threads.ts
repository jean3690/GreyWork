import type { ThreadGroup } from "../types";

/** 历史线程种子：按项目分组的会话历史。 */
export const MOCK_THREAD_GROUPS: ThreadGroup[] = [
  {
    project: "GreyWork 主仓",
    projectId: "p-gw-main",
    threads: [
      { id: "th-101", title: "Cesium WebGL 降级排查", time: "2 小时前" },
      { id: "th-102", title: "命令守卫单测补齐", time: "昨天" },
      { id: "th-103", title: "插件市场远程源接入", time: "周一" },
    ],
  },
  {
    project: "城市数据洞察",
    projectId: "p-city",
    threads: [
      { id: "th-201", title: "台风路径可视化分析", time: "3 天前" },
      { id: "th-202", title: "站点客流聚合报表", time: "上周" },
    ],
  },
  {
    project: "普通对话",
    projectId: "p-general",
    threads: [{ id: "th-301", title: "Vue3 组合式 API 疑问", time: "昨天" }],
  },
];
