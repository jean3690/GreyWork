import type { CoworkBudget, CoworkMail, CoworkSlot, CoworkTask } from "./types";

/** 单封信注入正文的长度上限；超出截断并标记，全文仍留在 run 快照与 UI 里。 */
const MAX_MAIL_BODY = 2000;
/** 任务板快照注入条数上限，最新的在前。 */
const MAX_BOARD_ROWS = 40;

/**
 * 协作指令手册。
 *
 * greyWork 的 ACP 宿主目前不向 agent 会话注入 MCP 工具（`NewSessionRequest`
 * 未设 mcp_servers），所以协作动作走「输出里的 ```cowork 围栏」这条文本通道：
 * agent 照常回复，引擎从回复里解析指令并执行。等宿主支持工具注入后，只需换掉
 * 引擎的指令来源，协议语义不用动。
 */
export const COWORK_PROTOCOL = `## 协作指令
与团队的一切交互都通过在回复里输出 \`\`\`cowork 代码块完成，块内是一条指令或指令数组：

\`\`\`cowork
[{"op":"message","to":"成员名","body":"要说的话","summary":"一句话摘要"},
 {"op":"task","subject":"任务标题","detail":"补充说明","owner":"负责人","blockedBy":["ct-1"]},
 {"op":"task_update","taskId":"ct-2","status":"done","result":"结论"}]
\`\`\`

- \`message\`：投进对方收件箱并唤醒对方。\`to\` 填成员名或成员位 id，填 \`*\` 表示广播给全部成员。
- \`task\`：建任务。带 \`owner\` 即刻派发，不必再补一条 message 通知。
- \`task_update\`：改状态或写结论，status 取 pending | in_progress | done | failed。
- 有先后关系就用 \`blockedBy\` 声明，**不要**口头让别人「等某人做完」——前置完成时系统会自动唤醒下游负责人。
- 长产出写进 \`task_update.result\`，不要塞进 message，避免刷爆别人的上下文。
- 对用户说话直接正常输出文字，不需要指令。

## 待命规则（重要）
没活可干时**直接结束本回合**，不要在回复里空转等待。
新消息到达时系统会立刻重新唤醒你，这是无损的等待方式。
若你保持回合不结束地「等待」，底层模型请求会一直挂着，直到 provider 超时把你判为失败。`;

const slotLine = (slot: CoworkSlot): string =>
  `- ${slot.name}（id: ${slot.id}，角色: ${slot.role === "leader" ? "leader" : "成员"}，状态: ${slot.status}）`;

export interface LeaderPromptParams {
  goal: string;
  slots: readonly CoworkSlot[];
  budget: CoworkBudget;
}

export function buildLeaderPrompt(params: LeaderPromptParams): string {
  const { goal, slots, budget } = params;
  const teammates = slots.filter((slot) => slot.role !== "leader");
  const roster = teammates.length === 0 ? "-（暂无成员，只能自己完成或向用户说明）" : teammates.map(slotLine).join("\n");
  const wallClockMinutes = Math.round(budget.maxWallClockMs / 60000);

  return `# 你是团队 leader

## 目标
${goal}

## 你的职责
拆解目标、派活、跟进、汇总结论。不要亲自做实现工作——那是成员的事。

## 团队成员
${roster}

## 预算
本次运行最多 ${budget.maxTurns} 个回合，每位成员最多 ${budget.maxTurnsPerSlot} 个回合，墙钟 ${wallClockMinutes} 分钟。
触顶会暂停整个运行并交回用户决定，所以不要用回合去做寒暄和复述。

## 工作流程
1. 读收件箱与任务板，确认当前进展。
2. 需要拆解时用 \`task\` 建任务并指定 \`owner\`；有先后关系的一次性用 \`blockedBy\` 把整条链建好，系统会按依赖顺序唤醒各负责人。
3. 成员回合结束会自动给你一条进度通知，不需要逐条回应；只在要调整计划时才发指令。
4. 成员把结论写在任务的 result 里，你从任务板读，不要要求他们把全文再发一遍。
5. 全部任务完成后，直接用文字向用户汇总最终结论。

${COWORK_PROTOCOL}`;
}

export interface TeammatePromptParams {
  slot: CoworkSlot;
  slots: readonly CoworkSlot[];
}

export function buildTeammatePrompt(params: TeammatePromptParams): string {
  const { slot, slots } = params;
  const leader = slots.find((item) => item.role === "leader");
  const peers = slots.filter((item) => item.id !== slot.id && item.role !== "leader");
  const peerLine = peers.length === 0 ? "（无）" : peers.map((item) => item.name).join("、");

  return `# 你是团队成员 ${slot.name}

## 你的团队
Leader：${leader?.name ?? "（无）"}
其他成员：${peerLine}

## 工作流程
1. 读收件箱，确认这一轮要做什么。
2. 认领任务：\`task_update\` 置 \`in_progress\`。
3. 用你自己的工具（读写文件、执行命令、检索等）真正把活干完。
4. 完成后 \`task_update\` 置 \`done\` 并把结论写进 \`result\`。
5. 需要澄清或遇到阻塞，用 \`message\` 找 leader；不要停在回合里干等。

只做分配给你的任务，不要越界替别人干活。

${COWORK_PROTOCOL}`;
}

const mailHeading = (mail: CoworkMail, nameOf: (slotId: string) => string): string => {
  const from = mail.from === "user" ? "用户" : nameOf(mail.from);
  if (mail.kind === "assignment") return `[任务派发 · 来自 ${from}]`;
  if (mail.kind === "unblocked") return `[前置已完成 · 可以开工]`;
  if (mail.kind === "idle_notice") return `[进度通知 · ${from}]`;
  return `[来自 ${from}]`;
};

/** 把未读信件渲染成注入 prompt 的收件箱段落。 */
export function formatInbox(mail: readonly CoworkMail[], slots: readonly CoworkSlot[]): string {
  if (mail.length === 0) return "## 收件箱\n（空）";
  const nameOf = (slotId: string): string => slots.find((slot) => slot.id === slotId)?.name ?? slotId;
  const lines = mail.map((item) => {
    const body =
      item.body.length > MAX_MAIL_BODY ? `${item.body.slice(0, MAX_MAIL_BODY)}\n…（正文过长已截断，完整内容见会话记录）` : item.body;
    const task = item.taskId ? ` 任务 ${item.taskId}` : "";
    return `${mailHeading(item, nameOf)}${task}\n${body}`;
  });
  return `## 收件箱（${mail.length} 封）\n${lines.join("\n\n")}`;
}

/**
 * 任务板快照。
 *
 * 因为没有工具通道可供 agent 按需查询，任务板必须随每个回合注入——否则成员位
 * 拿不到任务 id，就无法回写状态和结论。
 */
export function formatBoard(tasks: readonly CoworkTask[], slots: readonly CoworkSlot[]): string {
  if (tasks.length === 0) return "## 任务板\n（空）";
  const nameOf = (slotId: string): string => slots.find((slot) => slot.id === slotId)?.name ?? slotId;
  const rows = tasks.slice(-MAX_BOARD_ROWS).map((task) => {
    const owner = task.owner ? nameOf(task.owner) : "未分配";
    const blocked = task.blockedBy.length > 0 ? `，阻塞于 ${task.blockedBy.join("、")}` : "";
    const result = task.result ? `\n    结论：${task.result}` : "";
    return `- [${task.id}] ${task.subject}（${task.status}，负责人 ${owner}${blocked}）${result}`;
  });
  return `## 任务板\n${rows.join("\n")}`;
}
