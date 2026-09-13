greywork.registerAction("advance", async (state) => {
  const current = typeof state.count === "number" ? state.count : 0;
  return { count: Math.min(100, current + 10), status: "Worker 已执行" };
});

greywork.registerAction("complete", () => ({ count: 100, status: "已完成" }));

// 能力调用示例：经宿主 broker 发起 net.fetch（域名必须在 manifest requires.hosts 白名单内）。
greywork.registerAction("fetch-ip", async () => {
  try {
    const response = await greywork.call("net.fetch", { url: "https://api.github.com/meta" });
    return { status: `HTTP ${response.status} · 能力调用成功`, count: 100 };
  } catch (error) {
    return { status: `能力调用被拒：${error.message}` };
  }
});
