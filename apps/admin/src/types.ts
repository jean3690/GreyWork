/** 与 back/grey 的 admin DTO 一一对应；字段变化时两边一起改。 */

export interface UserSummary {
  id: number;
  email: string;
  displayName: string;
  role: "admin" | "user" | string;
}

export interface DeviceSummary {
  id: number;
  name: string;
  platform: string;
}

export interface Session {
  token: string;
  user: UserSummary;
  device: DeviceSummary;
}

export interface UserItem extends UserSummary {
  status: string;
  createdAt: string;
}

export interface UserDetail extends UserItem {
  deviceCount: number;
  lastActiveAt: string | null;
  providers: string[];
}

export interface DeviceItem {
  id: number;
  name: string;
  platform: string;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface EnrollCodeItem {
  id: number;
  hashPrefix: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  status: "active" | "used" | "expired" | string;
}

export interface IssuedCode {
  code: string;
  item: EnrollCodeItem;
}

export interface AuditLog {
  id: number;
  actorId: number | null;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: number | null;
  detail: string | null;
  createdAt: string;
}

export interface Overview {
  users: { total: number; active: number; disabled: number; admins: number; newToday: number; new7d: number };
  devices: { total: number; active24h: number };
  codes: { active: number; used: number; expired: number; issuedToday: number };
  hosts: { total: number; alive: number; bindings: number };
  channels: { total: number; active: number; degraded: number; disabled: number };
  llm: { keys: number; requests7d: number; tokens7d: number; tokensToday: number };
  audit: { today: number; total7d: number };
  trend: TrendPoint[];
  recentAudits: AuditLog[];
  generatedAt: string;
}

export interface TrendPoint {
  date: string;
  users: number;
  audits: number;
  llmRequests: number;
}

export interface HostItem {
  deviceId: number;
  userId: number;
  ownerEmail: string;
  name: string;
  version: string;
  alive: boolean;
  bindings: number;
  createdAt: string;
}

export interface ChannelItem {
  id: number;
  userId: number;
  ownerEmail: string;
  platform: string;
  accountRef: string;
  status: "active" | "degraded" | "disabled" | string;
  storedStatus: string;
  hostDeviceId: number | null;
  hostName: string | null;
  createdAt: string;
}

export interface LlmKeyItem {
  id: number;
  userId: number;
  ownerEmail: string;
  provider: string;
  label: string;
  baseUrl: string;
  status: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface StorageKindUsage {
  kind: string;
  objects: number;
  bytes: number;
}

export interface StorageObjectItem {
  id: number;
  userId: number;
  ownerEmail: string;
  name: string;
  kind: string;
  sizeBytes: number;
  visibility: string;
  status: string;
  createdAt: string;
}

export interface StorageOverview {
  /** 只算 ready 的对象；pending 单独计数。 */
  objects: number;
  bytes: number;
  pending: number;
  byKind: StorageKindUsage[];
  recent: StorageObjectItem[];
}

export interface AutomationTaskItem {
  id: string;
  userId: number;
  ownerEmail: string;
  name: string;
  execution: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface AutomationOverview {
  tasks: number;
  enabled: number;
  duePending: number;
  dueOverdue: number;
  runs7d: number;
  runsFailed7d: number;
  recent: AutomationTaskItem[];
}

export interface LlmUsageOverview {
  requests7d: number;
  tokens7d: number;
  requestsToday: number;
  tokensToday: number;
  byProvider: { provider: string; requests: number; tokens: number }[];
}
