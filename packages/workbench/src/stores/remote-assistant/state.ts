/**
 * 远程助手 store 的共享状态注册表：通道 refs（微信 / 钉钉 / 飞书的状态、扫码视图、
 * 活动流、联系人档案）与跨 store 依赖在这里一次性创建，切片只交换函数。
 *
 * 纯切片私有且不跨片共享的可变状态（loginEpoch / queue / activeToken 之类）
 * 留在各自切片闭包里，不需要进 locals。
 */
import { createLlmClient } from "@greywork/llm";
import { ref, type Ref } from "vue";
import type { DingTalkStatus } from "../../lib/dingtalk-backend";
import type { FeishuStatus } from "../../lib/feishu-backend";
import type { DiscordStatus } from "../../lib/discord-backend";
import type { QqStatus } from "../../lib/qq-backend";
import type { TelegramBotLink, TelegramStatus } from "../../lib/telegram-backend";
import type { WecomStatus } from "../../lib/wecom-backend";
import { wechatBackend, type WechatStatus } from "../../lib/wechat-backend";
import { useSessionStore } from "../session";
import { useSettingsStore } from "../settings";
import { useWorkspaceStore } from "../workspace";
import {
  IDLE_DISCORD_STATUS,
  IDLE_DINGTALK_REGISTER,
  IDLE_DINGTALK_STATUS,
  IDLE_FEISHU_REGISTER,
  IDLE_FEISHU_STATUS,
  IDLE_QQ_REGISTER,
  IDLE_QQ_STATUS,
  IDLE_STATUS,
  IDLE_TELEGRAM_STATUS,
  IDLE_WECOM_STATUS,
  readPeerArchive,
  type FeishuRegisterView,
  type DingTalkRegisterView,
  type QqRegisterView,
  type RemoteActivity,
  type RemotePeer,
  type WechatQrView,
} from "./shared";

export interface RemoteAssistantState {
  settings: ReturnType<typeof useSettingsStore>;
  session: ReturnType<typeof useSessionStore>;
  workspace: ReturnType<typeof useWorkspaceStore>;
  llm: ReturnType<typeof createLlmClient>;
  /** 桌面端可用性：宿主通道自己判断（浏览器态为 false，三条通道一致）。 */
  available: Ref<boolean>;
  initialized: Ref<boolean>;
  /** 微信通道状态（宿主直出形状）。 */
  status: Ref<WechatStatus>;
  /** 钉钉通道状态（宿主直出形状）。 */
  dingtalkStatus: Ref<DingTalkStatus>;
  /** 飞书通道状态（宿主直出形状）。 */
  feishuStatus: Ref<FeishuStatus>;
  /** Telegram 通道状态（宿主直出形状）。 */
  telegramStatus: Ref<TelegramStatus>;
  /** QQ 通道状态（宿主直出形状）。 */
  qqStatus: Ref<QqStatus>;
  /** Discord 通道状态（宿主直出形状）。 */
  discordStatus: Ref<DiscordStatus>;
  /** 企业微信通道状态（宿主直出形状）。 */
  wecomStatus: Ref<WecomStatus>;
  /** Telegram 机器人扫码链接（未取到时为 null，error 说明原因）。 */
  telegramBotLink: Ref<{ link: TelegramBotLink | null; error: string | null }>;
  /** 飞书扫码创建应用的界面状态。 */
  feishuRegister: Ref<FeishuRegisterView>;
  /** 钉钉扫码创建应用的界面状态。 */
  dingtalkRegister: Ref<DingTalkRegisterView>;
  /** QQ 扫码创建机器人的界面状态。 */
  qqRegister: Ref<QqRegisterView>;
  qr: Ref<WechatQrView | null>;
  qrError: Ref<string | null>;
  activity: Ref<RemoteActivity[]>;
  /** 联系人档案（持久化）：会话绑定、回发凭据与最近往来。 */
  peers: Ref<RemotePeer[]>;
}

export function createRemoteAssistantState(): RemoteAssistantState {
  return {
    settings: useSettingsStore(),
    session: useSessionStore(),
    workspace: useWorkspaceStore(),
    llm: createLlmClient(),
    available: ref(wechatBackend.supported()),
    initialized: ref(false),
    status: ref<WechatStatus>({ ...IDLE_STATUS }),
    dingtalkStatus: ref<DingTalkStatus>({ ...IDLE_DINGTALK_STATUS }),
    feishuStatus: ref<FeishuStatus>({ ...IDLE_FEISHU_STATUS }),
    telegramStatus: ref<TelegramStatus>({ ...IDLE_TELEGRAM_STATUS }),
    qqStatus: ref<QqStatus>({ ...IDLE_QQ_STATUS }),
    discordStatus: ref<DiscordStatus>({ ...IDLE_DISCORD_STATUS }),
    wecomStatus: ref<WecomStatus>({ ...IDLE_WECOM_STATUS }),
    telegramBotLink: ref<{ link: TelegramBotLink | null; error: string | null }>({ link: null, error: null }),
    feishuRegister: ref<FeishuRegisterView>({ ...IDLE_FEISHU_REGISTER }),
    dingtalkRegister: ref<DingTalkRegisterView>({ ...IDLE_DINGTALK_REGISTER }),
    qqRegister: ref<QqRegisterView>({ ...IDLE_QQ_REGISTER }),
    qr: ref<WechatQrView | null>(null),
    qrError: ref<string | null>(null),
    activity: ref<RemoteActivity[]>([]),
    peers: ref<RemotePeer[]>(readPeerArchive()),
  };
}
