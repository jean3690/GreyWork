/**
 * 远程回合的宿主能力提示（```sendfile 围栏协议）与默认媒体能力。
 *
 * 从 `pipeline.ts` 拆出（P5 大文件拆分）：纯函数 / 常量，无 store 依赖。
 */
import type { ChannelMediaCapability } from "../../types";

/**
 * 远程回合的宿主能力提示（```sendfile 围栏协议）：模型据此知道「对方不在本机」，
 * 以及要把文件交出来该怎么表达。中文字面量直发、不进 i18n —— 与 SCHEDULE_HINT 同款。
 *
 * 按通道的媒体能力分叉：能力不支持出站文件的通道（钉钉 / 企业微信）必须如实告知，
 * 否则模型会一直输出围栏、宿主一直拒发，双方都以为对方有问题。
 */
const REMOTE_SEND_HINT_HEAD = "【宿主能力提示 · 远程文件发送】你正在通过聊天通道与用户对话：用户**不在本机**，看不到你的工作区与磁盘。";

/** 未指定通道时的默认能力：可发任意类别（按「能发文件」生成提示）。 */
export const FULL_MEDIA_CAPABILITY: ChannelMediaCapability = {
  inbound: ["image", "video", "audio", "file"],
  outbound: ["image", "video", "audio", "file"],
};

export function remoteSendHint(cap: ChannelMediaCapability): string {
  if (cap.outbound.length === 0) {
    return [
      REMOTE_SEND_HINT_HEAD,
      "这条通道**只能收文件、不能发文件**。用户要求「把某个文件发给我」时，直接说明这条通道发不了文件（建议改用其他通道），**不要**输出任何围栏，也不要回答「文件已在本机、无需发送」。",
    ].join("\n");
  }
  if (!cap.outbound.includes("file")) {
    return [
      REMOTE_SEND_HINT_HEAD,
      "这条通道**只能发送图片**，发不了文件。用户要图片时，把图片放进工作区后在回复最末尾输出一个 ```sendfile 围栏（内容是图片绝对路径的 JSON 数组）：",
      '```sendfile\n["/绝对/路径/截图.png"]\n```',
      "用户要文件时，直接说明这条通道发不了文件、建议改用其他通道，**不要**输出围栏。用户没有要求发文件时，绝对不要输出该围栏。",
    ].join("\n");
  }
  return [
    REMOTE_SEND_HINT_HEAD,
    "用户要求「把某个文件发给我」时，**不要**回答「文件已在本机、无需发送」。正确做法是：把该文件放进你的工作区目录（若它已在工作区内则不必移动），然后在回复的**最末尾**输出一个 ```sendfile 代码围栏，内容为要发送文件的**绝对路径**组成的 JSON 数组，例如：",
    '```sendfile\n["/绝对/路径/报告.xlsx"]\n```',
    "规则：只输出一个围栏；路径必须是绝对路径，且落在工作区或用户已授权的目录内（否则宿主会拒发）；单个文件不超过 20MB；用户没有要求发文件时，绝对不要输出该围栏。",
  ].join("\n");
}
