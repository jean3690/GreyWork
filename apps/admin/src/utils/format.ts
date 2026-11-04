const DATE_TIME = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatDateTime(value?: string | null): string {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return DATE_TIME.format(date);
}

export function formatDate(value?: string | null): string {
  if (!value) {
    return "—";
  }
  // 趋势接口给的是纯日期（YYYY-MM-DD）：交给 Date 会按 UTC 解析，UTC- 时区会退回前一天。
  // 这类值直接切字符串，不做时区换算。
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dayOnly) {
    return Number(dayOnly[2]) + "/" + Number(dayOnly[3]);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.getMonth() + 1 + "/" + date.getDate();
}

export function formatNumber(value?: number | null): string {
  return (value ?? 0).toLocaleString("zh-CN");
}

/** token 数太大时压缩显示，避免卡片被 1,234,567 撑破。 */
export function formatTokens(value?: number | null): string {
  const total = value ?? 0;
  if (total >= 1_000_000) {
    return (total / 1_000_000).toFixed(total >= 10_000_000 ? 0 : 1) + "M";
  }
  if (total >= 1_000) {
    return (total / 1_000).toFixed(total >= 10_000 ? 0 : 1) + "K";
  }
  return String(total);
}

export const PLATFORM_LABELS: Record<string, string> = {
  wechat: "微信",
  wecom: "企业微信",
  feishu: "飞书",
  dingtalk: "钉钉",
  qq: "QQ",
  telegram: "Telegram",
  discord: "Discord",
  web: "Web",
  desktop: "桌面端",
  server: "服务端",
  mobile: "移动端",
};

export function platformLabel(platform?: string | null): string {
  if (!platform) {
    return "—";
  }
  return PLATFORM_LABELS[platform] ?? platform;
}

interface ActionMeta {
  label: string;
  tone: "primary" | "success" | "warning" | "danger" | "info";
}

export const ACTION_META: Record<string, ActionMeta> = {
  user_enable: { label: "启用用户", tone: "success" },
  user_disable: { label: "禁用用户", tone: "danger" },
  user_role_change: { label: "调整角色", tone: "warning" },
  user_sessions_revoke: { label: "踢下线", tone: "warning" },
  device_revoke: { label: "吊销设备", tone: "danger" },
  enroll_code_issue: { label: "签发入场码", tone: "primary" },
  enroll_code_revoke: { label: "撤销入场码", tone: "info" },
  channel_status: { label: "通道启停", tone: "warning" },
  admin_password_change: { label: "修改密码", tone: "info" },
  admin_login: { label: "运维台登录", tone: "primary" },
};

export function actionMeta(action: string): ActionMeta {
  return ACTION_META[action] ?? { label: action, tone: "info" };
}
