import { http } from "./http";
import type {
  AuditLog,
  AutomationOverview,
  CatalogDetail,
  CatalogItemView,
  ChannelItem,
  DeviceItem,
  EnrollCodeItem,
  HostItem,
  IssuedCode,
  LlmKeyItem,
  LlmUsageOverview,
  Overview,
  Session,
  StorageOverview,
  UserDetail,
  UserItem,
} from "../types";

export const adminApi = {
  login(email: string, password: string): Promise<Session> {
    return http.post<Session>("/api/admin/auth/login", { email, password });
  },
  logout(): Promise<void> {
    return http.post<void>("/api/auth/logout");
  },
  changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return http.post<void>("/api/admin/auth/password", { currentPassword, newPassword });
  },

  overview(): Promise<Overview> {
    return http.get<Overview>("/api/admin/overview");
  },

  users(query?: string, limit?: number): Promise<UserItem[]> {
    const params = new URLSearchParams();
    if (query) {
      params.set("query", query);
    }
    if (limit) {
      params.set("limit", String(limit));
    }
    const suffix = params.toString() ? "?" + params.toString() : "";
    return http.get<UserItem[]>("/api/admin/users" + suffix);
  },
  userDetail(id: string): Promise<UserDetail> {
    return http.get<UserDetail>("/api/admin/users/" + id + "/detail");
  },
  userDevices(id: string): Promise<DeviceItem[]> {
    return http.get<DeviceItem[]>("/api/admin/users/" + id + "/devices");
  },
  updateUser(id: string, patch: { status?: string; role?: string }): Promise<UserItem> {
    return http.patch<UserItem>("/api/admin/users/" + id, patch);
  },
  revokeSessions(id: string): Promise<{ devices: number }> {
    return http.delete<{ devices: number }>("/api/admin/users/" + id + "/sessions");
  },
  revokeDevice(id: string, deviceId: string): Promise<void> {
    return http.delete<void>("/api/admin/users/" + id + "/devices/" + deviceId);
  },

  enrollCodes(): Promise<EnrollCodeItem[]> {
    return http.get<EnrollCodeItem[]>("/api/admin/enroll-codes");
  },
  issueEnrollCode(expiresInHours: number): Promise<IssuedCode> {
    return http.post<IssuedCode>("/api/admin/enroll-codes", { expiresInHours });
  },
  revokeEnrollCode(id: string): Promise<void> {
    return http.delete<void>("/api/admin/enroll-codes/" + id);
  },

  hosts(): Promise<HostItem[]> {
    return http.get<HostItem[]>("/api/admin/hosts");
  },
  channels(): Promise<ChannelItem[]> {
    return http.get<ChannelItem[]>("/api/admin/channels");
  },
  setChannelStatus(id: string, status: "active" | "disabled"): Promise<ChannelItem> {
    return http.post<ChannelItem>("/api/admin/channels/" + id + "/status", { status });
  },
  storage(): Promise<StorageOverview> {
    return http.get<StorageOverview>("/api/admin/storage");
  },
  automation(): Promise<AutomationOverview> {
    return http.get<AutomationOverview>("/api/admin/automation");
  },
  llmKeys(): Promise<LlmKeyItem[]> {
    return http.get<LlmKeyItem[]>("/api/admin/llm/keys");
  },
  llmUsage(): Promise<LlmUsageOverview> {
    return http.get<LlmUsageOverview>("/api/admin/llm/usage");
  },

  audit(params: { targetType?: string; targetId?: number; limit?: number; offset?: number }): Promise<AuditLog[]> {
    const search = new URLSearchParams();
    if (params.targetType) {
      search.set("targetType", params.targetType);
    }
    if (params.targetId !== undefined && params.targetId !== null) {
      search.set("targetId", String(params.targetId));
    }
    search.set("limit", String(params.limit ?? 50));
    search.set("offset", String(params.offset ?? 0));
    return http.get<AuditLog[]>("/api/admin/audit?" + search.toString());
  },

  catalog(kind?: string): Promise<CatalogItemView[]> {
    return http.get<CatalogItemView[]>("/api/admin/catalog?kind=" + (kind ?? "all"));
  },
  catalogDetail(id: string): Promise<CatalogDetail> {
    return http.get<CatalogDetail>("/api/admin/catalog/" + id);
  },
  createCatalogSkill(payload: Record<string, unknown>): Promise<CatalogItemView> {
    return http.post<CatalogItemView>("/api/admin/catalog/skill", payload);
  },
  updateCatalogSkill(id: string, payload: Record<string, unknown>): Promise<CatalogItemView> {
    return http.put<CatalogItemView>("/api/admin/catalog/skill/" + id, payload);
  },
  createCatalogMcp(payload: Record<string, unknown>): Promise<CatalogItemView> {
    return http.post<CatalogItemView>("/api/admin/catalog/mcp", payload);
  },
  updateCatalogMcp(id: string, payload: Record<string, unknown>): Promise<CatalogItemView> {
    return http.put<CatalogItemView>("/api/admin/catalog/mcp/" + id, payload);
  },
  setCatalogEnabled(id: string, enabled: boolean): Promise<CatalogItemView> {
    return http.post<CatalogItemView>("/api/admin/catalog/" + id + "/enabled", { enabled });
  },
  deleteCatalog(id: string): Promise<void> {
    return http.delete<void>("/api/admin/catalog/" + id);
  },
};
